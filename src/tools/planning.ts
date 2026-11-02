import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DendreoError, type DendreoClient, type Row } from "../dendreo/client.js";
import { retirerFormateur } from "./gestion.js";
import { findEntreprise, findFormateur, findSalle, findSession, single } from "./resolve.js";
import { DATE, LIMITE, addDays, borner, heuresCreneau, json, nomDe, splitDateTime, today } from "./util.js";

const HEURE = z.string().regex(/^\d{2}:\d{2}$/);

const slotLabel = (c: Row) => {
  const d = splitDateTime(c.date_debut);
  return `${d.date} ${d.heure}-${splitDateTime(c.date_fin).heure}`;
};

/** Message lisible pour les refus Dendreo sur un créneau. */
function explain(e: unknown): string {
  const msg = (e as Error).message;
  return e instanceof DendreoError && e.status === 422
    ? `refusé par Dendreo (créneau probablement émargé ou facturé) : ${msg}`
    : `erreur : ${msg}`;
}

export function registerPlanningTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "staffer_formateur",
    {
      description:
        "Ajoute un formateur à une action de formation et l'affecte à tous ses créneaux ou à certains jours. " +
        "Peut remplacer un autre formateur sur ces créneaux (il en est déstaffé). `retirer=true` : déstaffe `formateur` " +
        "(certains jours, ou tous ses créneaux et la session) ; Dendreo refuse s'il a émargé, est facturé ou a été noté.",
      inputSchema: {
        session: z.string(),
        formateur: z.string().optional().describe("Formateur à staffer : prénom et nom, ou id (ou utiliser entreprise_sous_traitante)"),
        entreprise_sous_traitante: z.string().optional().describe("Entreprise sous-traitante à staffer à la place d'un formateur (raison sociale, ENT_… ou id) : ajoutée à la session, sans créneaux"),
        jours: z.array(DATE).optional().describe("Limiter à ces jours (AAAA-MM-JJ). Par défaut tous les créneaux"),
        remplace: z.string().optional().describe("Formateur à retirer de ces créneaux : prénom et nom, ou id"),
        retirer: z.boolean().default(false),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.retirer) {
        if (!args.formateur) return json({ erreur: "Préciser le formateur à retirer." });
        return retirerFormateur(client, { session: args.session, formateur: args.formateur, jours: args.jours, dry_run: args.dry_run });
      }
      const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
      if (!("row" in s)) return json(s);
      if (args.entreprise_sous_traitante) {
        const e = single(await findEntreprise(client, args.entreprise_sous_traitante), "Entreprise sous-traitante");
        if (!("row" in e)) return json(e);
        const idE = String(e.row.id_entreprise);
        const existants = await client.list("lafs.php", { id_action_de_formation: String(s.row.id_action_de_formation) });
        const dejaLa = existants.some((l) => String(l.id_entreprise_formateur) === idE);
        const recap = { session: `${s.row.numero_complet} — ${s.row.intitule}`, entreprise_sous_traitante: e.row.raison_sociale, deja_staffee: dejaLa };
        if (args.dry_run || dejaLa) return json({ dry_run: args.dry_run, ...recap });
        await client.post("lafs.php", { id_action_de_formation: s.row.id_action_de_formation, id_entreprise_formateur: idE });
        return json({ ok: true, ...recap });
      }
      if (!args.formateur) return json({ erreur: "Préciser formateur ou entreprise_sous_traitante." });
      const f = single(await findFormateur(client, args.formateur), "Formateur");
      if (!("row" in f)) return json(f);
      let ancien: Row | undefined;
      if (args.remplace) {
        const a = single(await findFormateur(client, args.remplace), "Formateur à remplacer");
        if (!("row" in a)) return json(a);
        ancien = a.row;
      }
      const idAdf = String(s.row.id_action_de_formation);
      const idF = String(f.row.id_formateur);

      const [lafs, creneaux, lcfs] = await Promise.all([
        client.list("lafs.php", { id_action_de_formation: idAdf }),
        client.list("creneaux.php", { id_action_de_formation: idAdf }),
        client.list("lcfs.php", { id_action_de_formation: idAdf }),
      ]);
      const cibles = args.jours ? creneaux.filter((c) => args.jours!.includes(splitDateTime(c.date_debut).date)) : creneaux;
      const staffe = (idCreneau: unknown, idFormateur: string) =>
        lcfs.some(
          (l) => String(l.id_creneau) === String(idCreneau) && String(l.status) === "1" &&
            (String(l.id_formateur ?? "") === idFormateur ||
              lafs.some((laf) => String(laf.id_laf) === String(l.id_laf) && String(laf.id_formateur) === idFormateur)),
        );
      const aAjouterSurAdf = !lafs.some((l) => String(l.id_formateur) === idF);
      const aStaffer = cibles.filter((c) => !staffe(c.id_creneau, idF));
      const aRetirer = ancien ? cibles.filter((c) => staffe(c.id_creneau, String(ancien!.id_formateur))) : [];

      const recap = {
        session: `${s.row.numero_complet} — ${s.row.intitule}`,
        formateur: `${f.row.prenom} ${f.row.nom}`,
        ajout_sur_la_session: aAjouterSurAdf,
        creneaux_a_staffer: aStaffer.map(slotLabel),
        ...(ancien ? { retire: `${ancien.prenom} ${ancien.nom}`, creneaux_a_destaffer: aRetirer.map(slotLabel) } : {}),
        ...(cibles.length === 0 ? { avertissement: "Aucun créneau ne correspond aux jours demandés." } : {}),
      };
      if (args.dry_run) return json({ dry_run: true, ...recap });

      const journal: string[] = [];
      if (aAjouterSurAdf) {
        await client.post("lafs.php", { id_action_de_formation: idAdf, id_formateur: idF });
        journal.push("Formateur ajouté à la session");
      }
      for (const c of aStaffer) {
        try {
          await client.post("lcfs.php", { id_creneau: c.id_creneau, id_formateur: idF, status: 1 });
          journal.push(`${slotLabel(c)} : staffé`);
        } catch (e) {
          journal.push(`${slotLabel(c)} : ${explain(e)}`);
        }
      }
      for (const c of aRetirer) {
        try {
          await client.post("lcfs.php", { id_creneau: c.id_creneau, id_formateur: ancien!.id_formateur, status: 0 });
          journal.push(`${slotLabel(c)} : ${ancien!.prenom} ${ancien!.nom} déstaffé`);
        } catch (e) {
          journal.push(`${slotLabel(c)} : ${explain(e)}`);
        }
      }
      return json({ ...recap, journal });
    },
  );

  server.registerTool(
    "gerer_creneaux",
    {
      description:
        "Modifie le planning d'une action de formation : ajouter des créneaux, modifier la date, les heures ou l'intitulé " +
        "de créneaux existants, décaler des créneaux d'un nombre de jours, ou définir la salle / le lien visio d'un créneau " +
        "(alerte si la capacité de la salle est inférieure aux inscrits). Un créneau émargé ne peut pas être modifié.",
      inputSchema: {
        session: z.string(),
        ajouter: z
          .array(z.object({ date: DATE, heure_debut: HEURE, heure_fin: HEURE, intitule: z.string().optional(),
          salle: z.string().optional().describe("Salle (intitulé ou id) du créneau"),
          url_participants: z.string().optional().describe("Lien visio participants (salle virtuelle ; exige une salle)"),
          url_formateurs: z.string().optional().describe("Lien visio formateurs"),
          }))
          .optional(),
        modifier: z
          .array(
            z.object({
              id_creneau: z.string(),
              date: DATE.optional(),
              heure_debut: HEURE.optional(),
              heure_fin: HEURE.optional(),
              intitule: z.string().optional(),
              salle: z.string().optional().describe("Salle (intitulé ou id) du créneau"),
              url_participants: z.string().optional().describe("Lien visio participants (salle virtuelle ; exige une salle)"),
              url_formateurs: z.string().optional().describe("Lien visio formateurs"),
            }),
          )
          .optional()
          .describe("Créneaux à modifier (id visible avec detail_session)"),
        decaler_jours: z.number().int().optional().describe("Décale de N jours (négatif = avancer)"),
        decaler_ids: z.array(z.string()).optional().describe("Créneaux à décaler. Par défaut tous ceux de la session"),
        id_lam: z.string().optional().describe("Module (programmation) des nouveaux créneaux si la session en a plusieurs"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const creneaux = await client.list("creneaux.php", { id_action_de_formation: idAdf });
      const byId = new Map(creneaux.map((c) => [String(c.id_creneau), c]));

      let idLam = args.id_lam;
      if (args.ajouter?.length && !idLam) {
        const lams = await client.list("lams.php", { id_action_de_formation: idAdf });
        if (lams.length !== 1) {
          return json({
            erreur: "La session contient plusieurs modules : préciser id_lam.",
            modules: lams.map((l) => ({ id_lam: l.id_lam, intitule: l.intitule ?? l.intitule_module })),
          });
        }
        idLam = String(lams[0].id_lam);
      }

      // Salles demandées (par créneau) : résolues une fois, avec contrôle de capacité.
      const salles = new Map<string, Row>();
      const alertes: string[] = [];
      const demandesSalle = [...(args.ajouter ?? []), ...(args.modifier ?? [])].map((x) => x.salle).filter((x): x is string => !!x);
      for (const nom of new Set(demandesSalle)) {
        const r = single(await findSalle(client, nom), `Salle « ${nom} »`);
        if (!("row" in r)) return json(r);
        const [detail] = await client.list("salles_de_formation.php", { id: String(r.row.id_salle_de_formation) });
        salles.set(nom, { ...r.row, ...detail });
      }
      if (salles.size) {
        const [adf] = await client.list("actions_de_formation.php", { id: idAdf, fields: "nb_participants_inscrits" });
        for (const sl of salles.values()) {
          const cap = Number(sl.capacite_max ?? 0);
          if (cap > 0 && Number(adf?.nb_participants_inscrits ?? 0) > cap) alertes.push(`Salle « ${sl.intitule} » : capacité ${cap} < ${adf?.nb_participants_inscrits} inscrits.`);
        }
      }
      const lieu = (x: { salle?: string; url_participants?: string; url_formateurs?: string }): Row => ({
        ...(x.salle ? { id_salle_de_formation: salles.get(x.salle)?.id_salle_de_formation } : {}),
        ...(x.url_participants ? { url_participants: x.url_participants } : {}),
        ...(x.url_formateurs ? { url_formateurs: x.url_formateurs } : {}),
      });

      type Op = { quoi: string; body: Row };
      const ops: Op[] = [];
      for (const a of args.ajouter ?? []) {
        ops.push({
          quoi: `ajout ${a.date} ${a.heure_debut}-${a.heure_fin}`,
          body: { id_lam: idLam, date: a.date, heure_debut: a.heure_debut, heure_fin: a.heure_fin, ...(a.intitule ? { name: a.intitule } : {}), ...lieu(a) },
        });
      }
      const inconnus: string[] = [];
      // Dendreo exige date + heures à chaque édition : on complète avec les valeurs actuelles.
      const edit = (c: Row, patch: { date?: string; heure_debut?: string; heure_fin?: string; intitule?: string; salle?: string; url_participants?: string; url_formateurs?: string }) => {
        const d = splitDateTime(c.date_debut);
        const body: Row = {
          id: c.id_creneau,
          date: patch.date ?? d.date,
          heure_debut: patch.heure_debut ?? d.heure,
          heure_fin: patch.heure_fin ?? splitDateTime(c.date_fin).heure,
          ...(patch.intitule !== undefined ? { name: patch.intitule } : {}),
          ...lieu(patch),
        };
        return { quoi: `${slotLabel(c)} → ${body.date} ${body.heure_debut}-${body.heure_fin}`, body };
      };
      for (const m of args.modifier ?? []) {
        const c = byId.get(m.id_creneau);
        if (c) ops.push(edit(c, m));
        else inconnus.push(m.id_creneau);
      }
      if (args.decaler_jours) {
        const ids = args.decaler_ids ?? creneaux.map((c) => String(c.id_creneau));
        for (const id of ids) {
          const c = byId.get(id);
          if (c) ops.push(edit(c, { date: addDays(splitDateTime(c.date_debut).date, args.decaler_jours) }));
          else inconnus.push(id);
        }
      }

      const recap = {
        session: `${s.row.numero_complet} — ${s.row.intitule}`,
        operations: ops.map((o) => o.quoi),
        ...(alertes.length ? { alertes } : {}),
        ...(inconnus.length ? { creneaux_introuvables: inconnus } : {}),
      };
      if (args.dry_run || ops.length === 0) return json({ dry_run: args.dry_run, ...recap });

      const journal: string[] = [];
      for (const o of ops) {
        try {
          await client.post("creneaux.php", o.body);
          journal.push(`${o.quoi} : ok`);
        } catch (e) {
          journal.push(`${o.quoi} : ${explain(e)}`);
        }
      }
      return json({ ...recap, journal, rappel: "Vérifier le staffing des formateurs sur les créneaux ajoutés (staffer_formateur)." });
    },
  );

  server.registerTool(
    "suivi_rsvp",
    {
      description:
        "Réponses des formateurs aux invitations RSVP, créneau par créneau : Oui, Non, Peut-être ou sans réponse, avec la date " +
        "d'envoi et les remarques. L'envoi des invitations se fait dans Dendreo (l'API ne le permet pas).",
      inputSchema: {
        session: z.string().optional(),
        formateur: z.string().optional().describe("Prénom et nom, ou id"),
        du: DATE.optional().describe("Sans session : début de période (défaut : aujourd'hui)"),
        au: DATE.optional().describe("Sans session : fin de période (défaut : dans 30 jours)"),
        seulement_sans_reponse_ou_refus: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const query: Record<string, string> = {};
      let titre: string | undefined;
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        query.id_action_de_formation = String(s.row.id_action_de_formation);
        titre = `${s.row.numero_complet} — ${s.row.intitule}`;
      }
      let idFormateur: string | undefined;
      if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        idFormateur = String(f.row.id_formateur);
        query.id_formateur = idFormateur;
      }
      if (!args.session) {
        const debut = args.du ?? today();
        query.started_after = debut;
        query.started_before = `${args.au ?? addDays(debut, 30)} 23:59:59`;
      }
      const creneaux = await client.list("creneaux.php", { ...query, include: "lcfs,formateurs" });
      const nomsLaf = new Map<string, { nom?: string; id: unknown }>();
      for (const id of [...new Set(creneaux.map((c) => String(c.id_action_de_formation)))].slice(0, 40)) {
        for (const l of await client.list("lafs.php", { id_action_de_formation: id, include: "formateur" })) {
          nomsLaf.set(String(l.id_laf), { nom: nomDe(l.formateur), id: l.id_formateur });
        }
      }
      const lignes = creneaux.flatMap((c) =>
        ((c.lcfs ?? []) as Row[])
          .filter((l) => String(l.status ?? "1") === "1")
          .map((l) => ({
            session: c.id_action_de_formation,
            creneau: slotLabel(c),
            formateur: nomDe((l.formateur as Row | undefined) ?? undefined) ?? nomsLaf.get(String(l.id_laf))?.nom ?? `laf ${l.id_laf}`,
            id_formateur: l.id_formateur ?? nomsLaf.get(String(l.id_laf))?.id,
            reponse: String(l.rsvp_status || "") || "sans réponse",
            envoye_le: l.rsvp_sent_at || undefined,
            remarque: l.rsvp_notes || undefined,
          })),
      ).filter((l) => !idFormateur || !l.id_formateur || String(l.id_formateur) === idFormateur)
       .filter((l) => !args.seulement_sans_reponse_ou_refus || !/^(oui|yes|accepted)$/i.test(String(l.reponse)));
      const compte: Record<string, number> = {};
      for (const l of lignes) compte[l.reponse] = (compte[l.reponse] ?? 0) + 1;
      return json({ session: titre, nombre: lignes.length, par_reponse: compte, confirmations: lignes });
    },
  );

  server.registerTool(
    "agenda",
    {
      description:
        "Vue agenda d'une période, par formateur (= planning du formateur), salle ou entreprise : créneaux triés, session, étape et remplissage (inscrits / places).",
      inputSchema: {
        du: DATE.optional().describe("Défaut : aujourd'hui"),
        au: DATE.optional().describe("Défaut : 14 jours après le début"),
        formateur: z.string().optional().describe("Prénom et nom, ou id"),
        salle: z.string().optional().describe("Intitulé ou id"),
        entreprise: z.string().optional().describe("Raison sociale, ENT_… ou id (sessions de cette entreprise)"),
        limite: LIMITE,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const du = args.du ?? today();
      const au = args.au ?? addDays(du, 14);
      const query: Record<string, string> = { started_after: du, started_before: `${au} 23:59:59` };
      const filtres: Record<string, unknown> = {};
      if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        query.id_formateur = String(f.row.id_formateur);
        filtres.formateur = `${f.row.prenom} ${f.row.nom}`;
      }
      if (args.salle) {
        const r = single(await findSalle(client, args.salle), "Salle");
        if (!("row" in r)) return json(r);
        query.id_salle_de_formation = String(r.row.id_salle_de_formation);
        filtres.salle = r.row.intitule;
      }
      let adfEntreprise: Set<string> | undefined;
      if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        const laes = await client.list("laes.php", { id_entreprise: String(e.row.id_entreprise) });
        adfEntreprise = new Set(laes.map((l) => String(l.id_action_de_formation)));
        filtres.entreprise = e.row.raison_sociale;
      }
      let creneaux = await client.list("creneaux.php", query);
      if (adfEntreprise) creneaux = creneaux.filter((c) => adfEntreprise!.has(String(c.id_action_de_formation)));
      const ids = [...new Set(creneaux.map((c) => String(c.id_action_de_formation)))];
      const adfs = new Map<string, Row>();
      for (let i = 0; i < ids.length; i += 50) {
        for (const a of await client.list("actions_de_formation.php", { id: ids.slice(i, i + 50).join(","), fields: "id_action_de_formation,numero_complet,intitule,id_etape_process,nb_participants_inscrits,nb_participants_max" })) {
          adfs.set(String(a.id_action_de_formation), a);
        }
      }
      const etapes = new Map((await client.list("etapes.php")).map((e) => [String(e.id_etape_process), String(e.intitule)]));
      const lignes = creneaux
        .map((c) => {
          const a = adfs.get(String(c.id_action_de_formation));
          return {
            date: splitDateTime(c.date_debut).date,
            horaire: slotLabel(c).slice(11),
            session: a ? `${a.numero_complet} — ${a.intitule}` : c.id_action_de_formation,
            etape: a ? etapes.get(String(a.id_etape_process)) : undefined,
            remplissage: a ? `${a.nb_participants_inscrits ?? "?"}/${a.nb_participants_max ?? "?"}` : undefined,
            creneau: c.name || undefined,
            id_salle: c.id_salle_de_formation || undefined,
          };
        })
        .sort((x, y) => `${x.date} ${x.horaire}`.localeCompare(`${y.date} ${y.horaire}`));
      const { items: creneauxAff, avertissement } = borner(lignes, args.limite);
      return json({ periode: `${du} → ${au}`, ...filtres, nb_creneaux: lignes.length, ...(avertissement ? { avertissement } : {}), creneaux: creneauxAff });
    },
  );

  server.registerTool(
    "occupation_salles",
    {
      description:
        "Taux d'occupation des salles sur une période : heures réservées sur les créneaux, comparées à une journée de " +
        "référence (heures ouvrées par jour × jours ouvrés). Pour l'export Dendreo exact, utiliser `telecharger_export` (slug occupation-salles).",
      inputSchema: {
        du: DATE.optional().describe("Défaut : début du mois"),
        au: DATE.optional().describe("Défaut : aujourd'hui"),
        heures_par_jour: z.number().min(1).max(24).default(7).describe("Heures ouvrées par jour pour le taux"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const au = args.au ?? today();
      const du = args.du ?? `${au.slice(0, 7)}-01`;
      const [creneaux, salles] = await Promise.all([
        client.list("creneaux.php", { started_after: du, started_before: `${au} 23:59:59` }),
        client.list("salles_de_formation.php", { fields: "id_salle_de_formation,intitule,ville" }),
      ]);
      let joursOuvres = 0;
      for (let d = du; d <= au; d = addDays(d, 1)) {
        const w = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (w !== 0 && w !== 6) joursOuvres++;
      }
      const capacite = joursOuvres * args.heures_par_jour;
      const heures = new Map<string, number>();
      for (const c of creneaux) {
        const k = String(c.id_salle_de_formation ?? "");
        if (!k || k === "0") continue;
        heures.set(k, (heures.get(k) ?? 0) + heuresCreneau(c));
      }
      const lignes = salles
        .map((sl) => {
          const h = heures.get(String(sl.id_salle_de_formation)) ?? 0;
          return { salle: sl.intitule, ville: sl.ville || undefined, heures_reservees: Math.round(h * 10) / 10, taux_occupation_pourcent: capacite ? Math.round((h / capacite) * 100) : undefined };
        })
        .sort((a, b) => b.heures_reservees - a.heures_reservees);
      return json({ periode: `${du} → ${au}`, jours_ouvres: joursOuvres, heures_disponibles_par_salle: capacite, salles: lignes });
    },
  );
}
