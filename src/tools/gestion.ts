import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DendreoError, type DendreoClient, type Row } from "../dendreo/client.js";
import { creerSession } from "./creation.js";
import {
  findEtape,
  findFormateur,
  findInscription,
  findModule,
  findSalle,
  findSession,
  inscriptionsSession,
  single,
} from "./resolve.js";
import { DATE, CHAMPS_PERSONNALISES, LIMITE, borner, json, nomDe, splitDateTime, today, vrai } from "./util.js";

const SESSION = z.string();

const sessionLabel = (adf: Row) => `${adf.numero_complet} — ${adf.intitule}`;
const nomLap = (l: Row) =>
  nomDe(l.participant) ?? (String(l.id_participant) === "0" ? "Participant non identifié" : `lap ${l.id_lap}`);
const slotLabel = (c: Row) => {
  const d = splitDateTime(c.date_debut);
  return `${d.date} ${d.heure}-${splitDateTime(c.date_fin).heure}`;
};
const erreur = (e: unknown) =>
  e instanceof DendreoError && e.status === 422 ? `refusé par Dendreo : ${(e as Error).message}` : `erreur : ${(e as Error).message}`;

async function sessionOuErreur(client: DendreoClient, session: string) {
  return single(await findSession(client, session), "Session");
}

/** Heures de présence ou d'absence déjà saisies pour une inscription. */
async function presencesSaisies(client: DendreoClient, idAdf: string, idLap: string): Promise<number> {
  const lcps = await client.list("lcps.php", { id_action_de_formation: idAdf, id_lap: idLap });
  return lcps.filter(
    (p) => String(p.id_lap) === idLap && (vrai(p.presence) || Number(p.total_heures_absence ?? 0) > 0),
  ).length;
}

/** Deux intervalles « AAAA-MM-JJ HH:MM:SS » se chevauchent-ils ? */
const chevauche = (a: Row, b: Row) => String(a.date_debut) < String(b.date_fin) && String(b.date_debut) < String(a.date_fin);

/**
 * Déstaffe un formateur d'une session, sur tous ses créneaux (il est alors retiré de la session) ou sur certains jours.
 * Utilisé par `staffer_formateur` avec `retirer=true`.
 */
export async function retirerFormateur(
  client: DendreoClient,
  args: { session: string; formateur: string; jours?: string[]; dry_run: boolean },
) {
  const s = await sessionOuErreur(client, args.session);
  if (!("row" in s)) return json(s);
  const f = single(await findFormateur(client, args.formateur), "Formateur");
  if (!("row" in f)) return json(f);
  const idAdf = String(s.row.id_action_de_formation);
  const idF = String(f.row.id_formateur);
  const [lafs, lcfs, creneaux] = await Promise.all([
    client.list("lafs.php", { id_action_de_formation: idAdf }),
    client.list("lcfs.php", { id_action_de_formation: idAdf }),
    client.list("creneaux.php", { id_action_de_formation: idAdf }),
  ]);
  const laf = lafs.find((l) => String(l.id_formateur) === idF);
  if (!laf) return json({ erreur: "Ce formateur n'est pas staffé sur cette session." });
  const creneauById = new Map(creneaux.map((c) => [String(c.id_creneau), c]));
  const siens = lcfs.filter(
    (l) => vrai(l.status) && (String(l.id_formateur ?? "") === idF || String(l.id_laf) === String(laf.id_laf)),
  );
  const cibles = args.jours
    ? siens.filter((l) => args.jours!.includes(splitDateTime(creneauById.get(String(l.id_creneau))?.date_debut).date))
    : siens;
  const retraitComplet = !args.jours || cibles.length === siens.length;
  const recap = {
    session: sessionLabel(s.row),
    formateur: `${f.row.prenom} ${f.row.nom}`,
    creneaux_a_destaffer: cibles.map((l) => slotLabel(creneauById.get(String(l.id_creneau)) ?? {})),
    retire_de_la_session: retraitComplet,
  };
  if (args.dry_run) return json({ dry_run: true, ...recap });
  const journal: string[] = [];
  for (const l of cibles) {
    const label = slotLabel(creneauById.get(String(l.id_creneau)) ?? {});
    try {
      await client.post("lcfs.php", { id_creneau: l.id_creneau, id_formateur: idF, status: 0 });
      journal.push(`${label} : déstaffé`);
    } catch (e) {
      journal.push(`${label} : ${erreur(e)}`);
    }
  }
  if (retraitComplet) {
    try {
      await client.delete("lafs.php", { id_laf: String(laf.id_laf) });
      journal.push("Formateur retiré de la session");
    } catch (e) {
      journal.push(`Retrait de la session : ${erreur(e)}`);
    }
  }
  return json({ ...recap, journal });
}

export function registerGestionTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "modifier_session",
    {
      description:
        "Modifie une action de formation existante : étape (ex. passer en « Réalisation » ou « Annulée »), intitulé, " +
        "salle, nombre de places, responsable, commentaires, publication au catalogue en ligne, émargement électronique, " +
        "champs personnalisés. Le type et les dates ne se modifient pas ici (dates : gerer_creneaux).",
      inputSchema: {
        session: SESSION,
        etape: z.string().optional().describe("Nouvelle étape, ex. « Réalisation »"),
        intitule: z.string().optional(),
        intitule_court: z.string().optional().describe("Intitulé affiché dans l'agenda"),
        salle: z.string().optional().describe("Salle de formation (intitulé ou id)"),
        places_min: z.number().int().optional(),
        places_max: z.number().int().optional(),
        id_responsable: z.number().int().optional(),
        id_commercial: z.number().int().optional(),
        commentaires: z.string().optional().describe("Commentaires internes (remplacent les existants)"),
        commentaires_agenda: z.string().optional().describe("Commentaires visibles sur l'agenda et les extranets"),
        publication_en_ligne: z.boolean().optional().describe("Publier au catalogue public et accepter les inscriptions en ligne"),
        emargement_electronique: z.boolean().optional(),
        champs_personnalises: CHAMPS_PERSONNALISES,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const adf = s.row;
      const body: Row = { id: adf.id_action_de_formation, intitule: args.intitule ?? adf.intitule };
      const avant: Row = {};
      const apres: Row = {};
      const change = (champ: string, valeur: unknown, libelle?: unknown) => {
        if (valeur === undefined) return;
        body[champ] = valeur;
        avant[champ] = adf[champ];
        apres[champ] = libelle ?? valeur;
      };
      if (args.etape) {
        const e = single(await findEtape(client, args.etape), "Étape");
        if (!("row" in e)) return json(e);
        change("id_etape_process", e.row.id_etape_process, e.row.intitule);
      }
      if (args.salle) {
        const r = single(await findSalle(client, args.salle), "Salle");
        if (!("row" in r)) return json(r);
        change("id_salle_de_formation", r.row.id_salle_de_formation, r.row.intitule);
      }
      if (args.intitule) change("intitule", args.intitule);
      change("intitule_court", args.intitule_court);
      change("nb_participants_min", args.places_min);
      change("nb_participants_max", args.places_max);
      change("id_responsable", args.id_responsable);
      change("id_commercial", args.id_commercial);
      change("commentaires", args.commentaires);
      change("commentaires_agenda", args.commentaires_agenda);
      if (args.publication_en_ligne !== undefined) change("inscription_online", args.publication_en_ligne ? 1 : 0);
      if (args.emargement_electronique !== undefined) change("esignature", args.emargement_electronique ? 1 : 0);
      for (const [k, v] of Object.entries(args.champs_personnalises ?? {})) change(k, v);

      if (Object.keys(apres).length === 0) return json({ erreur: "Aucune modification demandée." });
      const avertissements: string[] = [];
      const inscrits = Number(adf.nb_participants_inscrits ?? 0);
      if (args.places_max !== undefined && inscrits > args.places_max) {
        avertissements.push(`${inscrits} inscrits pour ${args.places_max} places maximum (signalé par Dendreo, non bloquant).`);
      }
      const recap = { session: sessionLabel(adf), avant, apres, ...(avertissements.length ? { avertissements } : {}) };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      await client.post("actions_de_formation.php", body);
      return json({ ok: true, ...recap });
    },
  );

  server.registerTool(
    "annuler_inscription",
    {
      description:
        "Supprime l'inscription de participants à une action de formation. Refuse les participants dont des présences " +
        "ou absences sont déjà saisies (à corriger dans Dendreo).",
      inputSchema: {
        session: SESSION,
        participants: z.array(z.string()).min(1).describe("Prénom et nom, email, id participant ou id_lap"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const laps = await inscriptionsSession(client, idAdf);
      const lignes: { participant: string; action: string; id_lap?: unknown; resultat?: string }[] = [];
      for (const q of args.participants) {
        const found = findInscription(laps, q);
        if (found.length !== 1) {
          lignes.push({ participant: q, action: found.length === 0 ? "non inscrit" : "ambigu : préciser l'email" });
          continue;
        }
        const lap = found[0];
        const saisies = await presencesSaisies(client, idAdf, String(lap.id_lap));
        lignes.push({
          participant: nomLap(lap),
          id_lap: lap.id_lap,
          action: saisies > 0 ? `refusé : ${saisies} présence(s)/absence(s) déjà saisie(s)` : "à désinscrire",
        });
      }
      const recap = { session: sessionLabel(s.row), participants: lignes };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      for (const l of lignes.filter((l) => l.action === "à désinscrire")) {
        try {
          await client.delete("laps.php", { id_lap: String(l.id_lap) });
          l.resultat = "désinscrit";
        } catch (e) {
          l.resultat = erreur(e);
        }
      }
      return json(recap);
    },
  );

  server.registerTool(
    "modifier_inscription",
    {
      description:
        "Modifie l'inscription d'un participant à une session : prix personnalisé (session mono-module), numéro de " +
        "dossier CPF, suivi pédagogique (remplace le texte existant).",
      inputSchema: {
        session: SESSION,
        participant: z.string().describe("Prénom et nom, email, id participant ou id_lap"),
        prix: z.number().optional(),
        num_dossier_cpf: z.string().optional(),
        suivi: z.string().optional().describe("Suivi pédagogique de l'inscription (remplace l'existant)"),
        champs_personnalises: CHAMPS_PERSONNALISES,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const p = single(findInscription(await inscriptionsSession(client, idAdf), args.participant), "Participant");
      if (!("row" in p)) return json({ ...p, candidats: p.candidats.map(nomLap) });
      const changements: Row = {
        ...(args.prix !== undefined ? { prix: args.prix } : {}),
        ...(args.num_dossier_cpf !== undefined ? { num_dossier_cpf: args.num_dossier_cpf } : {}),
        ...(args.suivi !== undefined ? { suivi: args.suivi } : {}),
        ...args.champs_personnalises,
      };
      if (Object.keys(changements).length === 0) return json({ erreur: "Aucune modification demandée." });
      const recap = { session: sessionLabel(s.row), participant: nomLap(p.row), changements };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      await client.post("laps.php", {
        id_lap: p.row.id_lap,
        id_action_de_formation: idAdf,
        id_participant: p.row.id_participant,
        ...changements,
      });
      return json({ ok: true, ...recap });
    },
  );

  server.registerTool(
    "transferer_inscription",
    {
      description:
        "Déplace un participant d'une session vers une autre (en général une autre date du même module) : inscription " +
        "à la nouvelle session puis désinscription de l'ancienne. Refusé si des présences sont déjà saisies sur l'ancienne.",
      inputSchema: {
        de_session: SESSION,
        vers_session: SESSION,
        participant: z.string().describe("Prénom et nom, email, id participant ou id_lap"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const [a, b] = await Promise.all([sessionOuErreur(client, args.de_session), sessionOuErreur(client, args.vers_session)]);
      if (!("row" in a)) return json(a);
      if (!("row" in b)) return json(b);
      const idA = String(a.row.id_action_de_formation);
      const idB = String(b.row.id_action_de_formation);
      const [lapsA, lapsB, lamsA, lamsB] = await Promise.all([
        inscriptionsSession(client, idA),
        client.list("laps.php", { id_action_de_formation: idB }),
        client.list("lams.php", { id_action_de_formation: idA }),
        client.list("lams.php", { id_action_de_formation: idB }),
      ]);
      const p = single(findInscription(lapsA, args.participant), "Participant");
      if (!("row" in p)) return json({ ...p, candidats: p.candidats.map(nomLap) });
      const lap = p.row;

      const bloquants: string[] = [];
      const avertissements: string[] = [];
      if (String(lap.id_participant) === "0") bloquants.push("Un participant non identifié ne peut pas être transféré.");
      if (lapsB.some((l) => String(l.id_participant) === String(lap.id_participant))) bloquants.push("Déjà inscrit à la session cible.");
      const saisies = await presencesSaisies(client, idA, String(lap.id_lap));
      if (saisies > 0) bloquants.push(`${saisies} présence(s)/absence(s) déjà saisie(s) sur la session d'origine.`);
      const modsA = new Set(lamsA.map((l) => String(l.id_module)));
      if (!lamsB.some((l) => modsA.has(String(l.id_module)))) avertissements.push("Les deux sessions ne portent pas sur le même module.");
      if (String(b.row.type) === "intra" && String(b.row.id_entreprise) !== String(lap.id_entreprise)) {
        avertissements.push("Session cible INTRA d'une autre entreprise : accepté seulement si l'entreprise est du même groupe.");
      }
      if (String(b.row.date_debut).slice(0, 10) < today()) avertissements.push("La session cible a déjà commencé.");
      const places = Number(b.row.nb_participants_max ?? 0);
      if (places > 0 && Number(b.row.nb_participants_inscrits ?? 0) >= places) avertissements.push("La session cible est complète (non bloquant).");

      const recap = {
        participant: nomLap(lap),
        de: sessionLabel(a.row),
        vers: `${sessionLabel(b.row)} (${String(b.row.date_debut).slice(0, 10)})`,
        ...(bloquants.length ? { bloquants } : {}),
        ...(avertissements.length ? { avertissements } : {}),
      };
      if (args.dry_run || bloquants.length) return json({ dry_run: args.dry_run, ...recap });

      await client.post("laps.php", {
        id_action_de_formation: idB,
        id_participant: lap.id_participant,
        ...(lap.id_entreprise && String(lap.id_entreprise) !== "0" ? { id_entreprise: lap.id_entreprise } : {}),
      });
      try {
        await client.delete("laps.php", { id_lap: String(lap.id_lap) });
      } catch (e) {
        return json({ ok: false, ...recap, message: `Inscrit à la nouvelle session mais pas désinscrit de l'ancienne : ${erreur(e)}` });
      }
      return json({ ok: true, ...recap });
    },
  );

  server.registerTool(
    "inscription_modules",
    {
      description:
        "Pour une session à plusieurs modules : affiche à quels modules chaque participant est inscrit, et permet " +
        "d'inscrire ou désinscrire un participant d'un module. Sans `participant`, liste toute la session.",
      inputSchema: {
        session: SESSION,
        participant: z.string().optional().describe("Prénom et nom, email ou id"),
        inscrire: z.array(z.string()).optional().describe("Modules à ajouter (intitulé ou id module)"),
        desinscrire: z.array(z.string()).optional().describe("Modules à retirer (intitulé ou id module)"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const lmps = await client.list("lmps.php", { id_action_de_formation: idAdf, include: "participant,module" });
      const intituleModule = (m: Row) => ((m.module ?? {}) as Row).intitule ?? `module ${m.id_module}`;

      if (!args.participant) {
        const parParticipant = new Map<string, { participant: unknown; modules: unknown[] }>();
        for (const m of lmps) {
          const k = String(m.id_lap);
          const e = parParticipant.get(k) ?? { participant: nomDe(m.participant) ?? `lap ${k}`, modules: [] };
          if (vrai(m.inscription)) e.modules.push(intituleModule(m));
          parParticipant.set(k, e);
        }
        return json({ session: sessionLabel(s.row), participants: [...parParticipant.values()] });
      }

      const laps = await inscriptionsSession(client, idAdf);
      const p = single(findInscription(laps, args.participant), "Participant");
      if (!("row" in p)) return json({ ...p, candidats: p.candidats.map(nomLap) });
      const siens = lmps.filter((m) => String(m.id_lap) === String(p.row.id_lap));
      const resoudre = async (q: string) => {
        const ids = new Set((await findModule(client, q)).map((m) => String(m.id_module)));
        return siens.filter((m) => ids.has(String(m.id_module)) || String(m.id_module) === q);
      };
      const ops: { lmp: Row; inscription: 0 | 1 }[] = [];
      const inconnus: string[] = [];
      for (const [liste, val] of [[args.inscrire, 1], [args.desinscrire, 0]] as const) {
        for (const q of liste ?? []) {
          const found = await resoudre(q);
          if (found.length === 0) inconnus.push(q);
          for (const lmp of found) if (vrai(lmp.inscription) !== (val === 1)) ops.push({ lmp, inscription: val });
        }
      }
      const recap = {
        session: sessionLabel(s.row),
        participant: nomLap(p.row),
        modules_actuels: siens.map((m) => ({ module: intituleModule(m), inscrit: vrai(m.inscription) })),
        changements: ops.map((o) => `${o.inscription ? "inscrire à" : "désinscrire de"} ${intituleModule(o.lmp)}`),
        ...(inconnus.length ? { modules_introuvables: inconnus } : {}),
      };
      if (args.dry_run || ops.length === 0) return json({ dry_run: args.dry_run, ...recap });
      const journal: string[] = [];
      for (const o of ops) {
        try {
          await client.post("lmps.php", { id_lmp: o.lmp.id_lmp, inscription: o.inscription });
          journal.push(`${intituleModule(o.lmp)} : ok`);
        } catch (e) {
          journal.push(`${intituleModule(o.lmp)} : ${erreur(e)}`);
        }
      }
      return json({ ...recap, journal });
    },
  );


  server.registerTool(
    "dupliquer_session",
    {
      description:
        "Crée une nouvelle session à partir d'une session existante (même module, formateur, type, entreprise, salle, " +
        "places et horaires) sur de nouvelles dates. Les participants ne sont pas copiés.",
      inputSchema: {
        session: SESSION,
        dates: z.array(DATE).min(1).describe("Jours de la nouvelle session (AAAA-MM-JJ)"),
        formateur: z.string().optional().describe("Autre formateur (par défaut celui de la session d'origine)"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const adf = s.row;
      const idAdf = String(adf.id_action_de_formation);
      const [lams, lafs, creneaux] = await Promise.all([
        client.list("lams.php", { id_action_de_formation: idAdf }),
        client.list("lafs.php", { id_action_de_formation: idAdf }),
        client.list("creneaux.php", { id_action_de_formation: idAdf }),
      ]);
      if (lams.length !== 1) {
        return json({ erreur: "Seules les sessions à un seul module peuvent être dupliquées.", modules: lams.map((l) => l.intitule) });
      }
      const premierJour = [...creneaux].sort((a, b) => String(a.date_debut).localeCompare(String(b.date_debut)))[0];
      const jour = splitDateTime(premierJour?.date_debut).date;
      const horaires = creneaux
        .filter((c) => splitDateTime(c.date_debut).date === jour)
        .sort((a, b) => String(a.date_debut).localeCompare(String(b.date_debut)))
        .map((c) => `${splitDateTime(c.date_debut).heure}-${splitDateTime(c.date_fin).heure}`)
        .join(";");
      const formateurOrigine = lafs[0];
      if (!args.formateur && !formateurOrigine?.id_formateur) {
        return json({ erreur: "Pas de formateur identifié sur la session d'origine : préciser `formateur`." });
      }
      const avertissements: string[] = [];
      if (lafs.length > 1) avertissements.push("Plusieurs formateurs sur l'origine : seul le premier est repris.");
      const horairesDistincts = new Set(
        Object.values(
          creneaux.reduce<Record<string, string[]>>((acc, c) => {
            const d = splitDateTime(c.date_debut).date;
            (acc[d] ??= []).push(`${splitDateTime(c.date_debut).heure}-${splitDateTime(c.date_fin).heure}`);
            return acc;
          }, {}),
        ).map((h) => h.sort().join(";")),
      );
      if (horairesDistincts.size > 1) avertissements.push(`Horaires différents selon les jours : ceux du ${jour} sont appliqués à tous.`);

      const id = (v: unknown) => (v && String(v) !== "0" ? Number(v) : undefined);
      const result = await creerSession(client, {
        formation: String(lams[0].intitule ?? ""),
        id_module: Number(lams[0].id_module),
        formateur: args.formateur ?? String(nomDe(formateurOrigine.formateur) ?? ""),
        id_formateur: args.formateur ? undefined : Number(formateurOrigine.id_formateur),
        dates: args.dates,
        horaires: horaires || "09:00-12:30;13:30-17:00",
        type: adf.type === "intra" ? "intra" : "inter",
        id_entreprise: adf.type === "intra" ? id(adf.id_entreprise) : undefined,
        salle: id(adf.id_salle_de_formation) ? String(adf.id_salle_de_formation) : undefined,
        places_min: id(adf.nb_participants_min),
        places_max: id(adf.nb_participants_max),
        id_responsable: id(adf.id_responsable),
        intitule: String(adf.intitule),
        dry_run: args.dry_run,
      });
      if (avertissements.length) {
        const first = result.content[0];
        if (first?.type === "text") {
          first.text = JSON.stringify({ origine: sessionLabel(adf), avertissements, ...JSON.parse(first.text) });
        }
      }
      return result;
    },
  );

  server.registerTool(
    "formateurs_disponibles",
    {
      description:
        "Pour un module et des dates, liste les formateurs aptes à l'animer (déclarés dans le catalogue) en indiquant " +
        "ceux qui sont libres et ceux qui ont déjà un créneau ces jours-là.",
      inputSchema: {
        formation: z.string().describe("Module : intitulé, MOD_… ou id"),
        dates: z.array(DATE).min(1).describe("Jours envisagés (AAAA-MM-JJ)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const m = single(await findModule(client, args.formation), "Formation");
      if (!("row" in m)) return json(m);
      const [mod] = await client.list("modules.php", { id: String(m.row.id_module), include: "formateurs_aptes" });
      const aptes = (Array.isArray(mod?.formateurs_aptes) ? mod.formateurs_aptes : []) as Row[];
      if (aptes.length === 0) {
        return json({ formation: m.row.intitule, message: "Aucun formateur apte déclaré sur ce module dans le catalogue." });
      }
      const dates = [...args.dates].sort();
      const formateurs = await Promise.all(
        aptes.map(async (f) => {
          const creneaux = await client.list("creneaux.php", {
            id_formateur: String(f.id_formateur),
            started_after: dates[0],
            started_before: `${dates[dates.length - 1]} 23:59:59`,
          });
          const pris = creneaux.filter((c) => dates.includes(splitDateTime(c.date_debut).date));
          return {
            formateur: nomDe(f) ?? f.id_formateur,
            id_formateur: f.id_formateur,
            disponible: pris.length === 0,
            deja_occupe: pris.map(slotLabel),
          };
        }),
      );
      formateurs.sort((a, b) => Number(b.disponible) - Number(a.disponible));
      return json({ formation: m.row.intitule, dates, formateurs });
    },
  );

  server.registerTool(
    "conflits_planning",
    {
      description:
        "Détecte sur une période les doubles réservations : un formateur ou une salle sur deux créneaux qui se " +
        "chevauchent, et les participants inscrits deux fois au même module sur des sessions qui se recouvrent.",
      inputSchema: {
        du: DATE.optional().describe("Début (défaut aujourd'hui)"),
        au: DATE.optional().describe("Fin (défaut +60 jours)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const du = args.du ?? today();
      const au = args.au ?? new Date(Date.parse(`${du}T00:00:00Z`) + 60 * 86400000).toISOString().slice(0, 10);
      const creneaux = await client.list("creneaux.php", { started_after: du, started_before: `${au} 23:59:59`, include: "formateurs" });
      const adfIds = [...new Set(creneaux.map((c) => String(c.id_action_de_formation)))];
      const adfs = adfIds.length
        ? await client.list("actions_de_formation.php", { id: adfIds.join(","), fields: "id_action_de_formation,numero_complet,intitule" })
        : [];
      const adfById = new Map(adfs.map((a) => [String(a.id_action_de_formation), a]));
      const where = (c: Row) => {
        const a = adfById.get(String(c.id_action_de_formation));
        return `${slotLabel(c)} (${a ? a.numero_complet : c.id_action_de_formation})`;
      };

      const conflits = (cle: (c: Row) => string[]) => {
        const groupes = new Map<string, Row[]>();
        for (const c of creneaux) for (const k of cle(c)) groupes.set(k, [...(groupes.get(k) ?? []), c]);
        const out: { qui: string; creneaux: string[] }[] = [];
        for (const [k, cs] of groupes) {
          const tri = [...cs].sort((a, b) => String(a.date_debut).localeCompare(String(b.date_debut)));
          for (let i = 0; i < tri.length; i++) {
            // Tri par début : dès qu'un créneau commence après la fin de tri[i], les suivants aussi.
            for (let j = i + 1; j < tri.length && chevauche(tri[i], tri[j]); j++) {
              out.push({ qui: k, creneaux: [where(tri[i]), where(tri[j])] });
            }
          }
        }
        return out;
      };
      const formateurs = conflits((c) =>
        ((c.formateurs ?? []) as Row[]).map((f) => nomDe(f) ?? `formateur ${f.id_formateur}`),
      );
      const salles = conflits((c) => (c.id_salle_de_formation && String(c.id_salle_de_formation) !== "0" ? [`salle ${c.id_salle_de_formation}`] : []));
      if (salles.length) {
        const noms = new Map(
          (await client.list("salles_de_formation.php", { fields: "id_salle_de_formation,intitule" })).map((s) => [
            `salle ${s.id_salle_de_formation}`,
            String(s.intitule),
          ]),
        );
        for (const c of salles) c.qui = noms.get(c.qui) ?? c.qui;
      }
      return json({ periode: { du, au }, conflits_formateurs: formateurs, conflits_salles: salles });
    },
  );

  server.registerTool(
    "souhaits_formation",
    {
      description:
        "Gère les souhaits de formation des participants (besoin exprimé pour un module) : `lister` par module ou " +
        "participant (ex. qui attend une session Excel ?), `ajouter` un souhait, `supprimer` des souhaits.",
      inputSchema: {
        action: z.enum(["lister", "ajouter", "supprimer"]).default("lister"),
        formation: z.string().optional().describe("Module : intitulé, MOD_… ou id"),
        id_participant: z.string().optional(),
        commentaire: z.string().optional(),
        echeance: DATE.optional().describe("Date avant laquelle le souhait devrait être exaucé"),
        ids: z.array(z.string()).optional().describe("Pour supprimer : ids des souhaits"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      let module: Row | undefined;
      if (args.formation) {
        const m = single(await findModule(client, args.formation), "Formation");
        if (!("row" in m)) return json(m);
        module = m.row;
      }
      if (args.action === "lister") {
        if (!module && !args.id_participant) return json({ erreur: "Préciser une formation ou un id_participant." });
        const rows = await client.list("souhaits.php", {
          module_id: module ? String(module.id_module) : undefined,
          participant_id: args.id_participant,
          include: "participant,module",
        });
        return json({
          nombre: rows.length,
          souhaits: rows.map((r) => ({
            id: r.id,
            participant: nomDe(r.participant) ?? r.participant_id,
            email: ((r.participant ?? {}) as Row).email || undefined,
            formation: ((r.module ?? {}) as Row).intitule ?? r.module_id,
            commentaire: r.commentaire || undefined,
            echeance: r.deadline_at || undefined,
            cree_le: r.date_add ?? r.created_at,
          })),
        });
      }
      if (args.action === "ajouter") {
        if (!module || !args.id_participant) return json({ erreur: "Préciser la formation et l'id_participant." });
        const body: Row = {
          participant_id: args.id_participant,
          module_id: module.id_module,
          ...(args.commentaire ? { commentaire: args.commentaire } : {}),
          ...(args.echeance ? { deadline_at: args.echeance } : {}),
        };
        if (args.dry_run) return json({ dry_run: true, souhait: { ...body, formation: module.intitule } });
        return json({ ok: true, souhait: await client.post("souhaits.php", body) });
      }
      if (!args.ids?.length) return json({ erreur: "Préciser les ids des souhaits à supprimer." });
      if (args.dry_run) return json({ dry_run: true, a_supprimer: args.ids });
      await client.delete("souhaits.php", { id: args.ids.join(",") });
      return json({ ok: true, supprimes: args.ids });
    },
  );

  server.registerTool(
    "entreprises_session",
    {
      description:
        "Liste les entreprises rattachées à une session (mode de financement, contact référent) et permet de changer " +
        "le contact référent d'une entreprise pour cette session.",
      inputSchema: {
        session: SESSION,
        id_lae: z.string().optional().describe("Pour changer le contact : lien session-entreprise (donné par la liste)"),
        id_contact: z.string().optional().describe("Nouveau contact (de la même entreprise)"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      if (args.id_lae && args.id_contact) {
        const body = { id_lae: args.id_lae, id_contact: args.id_contact };
        if (args.dry_run) return json({ dry_run: true, session: sessionLabel(s.row), changement: body });
        return json({ ok: true, resultat: await client.post("laes.php", body) });
      }
      const laes = await client.list("laes.php", { id_action_de_formation: String(s.row.id_action_de_formation) });
      const contactIds = [...new Set(laes.map((l) => String(l.id_contact)).filter((id) => id && id !== "0"))];
      const contacts = contactIds.length
        ? await client.list("contacts.php", { id: contactIds.join(","), fields: "id_contact,prenom,nom,email" })
        : [];
      const contactById = new Map(contacts.map((c) => [String(c.id_contact), c]));
      return json({
        session: sessionLabel(s.row),
        entreprises: laes.map((l) => {
          const c = contactById.get(String(l.id_contact));
          return {
            id_lae: l.id_lae,
            entreprise: ((l.entreprise ?? {}) as Row).raison_sociale ?? l.id_entreprise,
            id_entreprise: l.id_entreprise,
            mode_financement: l.mode_financement,
            contact: c ? `${nomDe(c)}${c.email ? ` <${c.email}>` : ""}` : undefined,
          };
        }),
      });
    },
  );

  server.registerTool(
    "sessions_permanentes",
    {
      description:
        "Liste les sessions permanentes (entrées et sorties permanentes) d'un module ou de tout le catalogue, " +
        "et permet d'en modifier le prix, la durée, l'ouverture ou la garantie.",
      inputSchema: {
        formation: z.string().optional().describe("Module : intitulé, MOD_… ou id"),
        id: z.string().optional().describe("Pour modifier : id de la session permanente"),
        prix: z.number().optional(),
        duree_heures: z.number().optional(),
        ouverte: z.boolean().optional(),
        garantie: z.boolean().optional(),
        limite: LIMITE,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const changements: Row = {
        ...(args.prix !== undefined ? { prix: args.prix } : {}),
        ...(args.duree_heures !== undefined ? { duree: args.duree_heures } : {}),
        ...(args.ouverte !== undefined ? { active: args.ouverte ? 1 : 0 } : {}),
        ...(args.garantie !== undefined ? { garantie: args.garantie ? 1 : 0 } : {}),
      };
      if (args.id && Object.keys(changements).length) {
        if (args.dry_run) return json({ dry_run: true, id: args.id, changements });
        return json({ ok: true, resultat: await client.post("sessions_permanentes.php", { id: args.id, ...changements }) });
      }
      let idModule: string | undefined;
      if (args.formation) {
        const m = single(await findModule(client, args.formation), "Formation");
        if (!("row" in m)) return json(m);
        idModule = String(m.row.id_module);
      }
      const { items, total, avertissement } = borner(await client.list("sessions_permanentes.php", { id_module: idModule, id: args.id }), args.limite);
      return json(total ? { nombre: total, avertissement, sessions: items } : items);
    },
  );

  server.registerTool(
    "prochaines_sessions_catalogue",
    {
      description:
        "Prochaines sessions visibles sur le catalogue public (comme le widget du site) : formation, dates, prix, " +
        "lieu, places, et la satisfaction moyenne du module.",
      inputSchema: { limite: LIMITE },
      annotations: { readOnlyHint: true },
    },
    async ({ limite }) => {
      const { items, total, avertissement } = borner(await client.list("catalogue_prochaines_sessions.php", { include: "satisfaction" }), limite);
      return json(total ? { nombre: total, avertissement, sessions: items } : items);
    },
  );
}
