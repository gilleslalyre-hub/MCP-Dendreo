import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { appliquer } from "./ecriture.js";
import { findSession, single } from "./resolve.js";
import { statut } from "./suivi.js";
import { json, lots, nomDe, normalize, num, splitDateTime, today, vrai } from "./util.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SESSION = z.string().describe("Id ou numéro ADF_…");

const FIELDS_ADF = "id_action_de_formation,numero_complet,intitule,type,date_debut,date_fin,id_etape_process,include_in_bpf,objectif,num_session_dpc,nb_participants_inscrits";

const ETAPE_NON_CONFIRMEE = /annul|non confirm|brouillon|pr[ée]vision|devis|en attente/;
const LIBELLE_FINANCEUR = /france travail|pole emploi|\bopco\b|\bopca\b|\bopcommerce\b|opco2i|afdas|akto|atlas|constructys|ocapiat|uniformation|agefiph|anfa|fif.?pl|region |conseil regional|caisse des depots|caisse d.?epargne|cpf/;

const label = (adf: Row) => `${adf.numero_complet} — ${adf.intitule}`;
const periode = (args: { annee?: number; du?: string; au?: string }) => {
  const annee = args.annee ?? Number(today().slice(0, 4));
  return { du: args.du ?? `${annee}-01-01`, au: args.au ?? `${annee}-12-31` };
};
const PERIODE_SCHEMA = {
  annee: z.number().int().optional().describe("Exercice (défaut : année en cours)"),
  du: DATE.optional().describe("Début de période (remplace l'année)"),
  au: DATE.optional().describe("Fin de période (remplace l'année)"),
};

async function sessionsPeriode(client: DendreoClient, du: string, au: string): Promise<Row[]> {
  const liste = await client.list("actions_de_formation.php", { started_after: du, started_before: `${au} 23:59:59`, fields: "id_action_de_formation" });
  const out: Row[] = [];
  for (const l of lots(liste.map((s) => String(s.id_action_de_formation)))) {
    out.push(...(await client.list("actions_de_formation.php", { id: l.join(","), fields: FIELDS_ADF })));
  }
  return out;
}

/** Présences non renseignées sur les créneaux passés d'une session. */
async function presencesManquantes(client: DendreoClient, idAdf: string): Promise<number> {
  const [creneaux, lcps] = await Promise.all([
    client.list("creneaux.php", { id_action_de_formation: idAdf }),
    client.list("lcps.php", { id_action_de_formation: idAdf }),
  ]);
  const passes = new Set(creneaux.filter((c) => String(c.date_fin) < `${today()} 23:59:59`).map((c) => String(c.id_creneau)));
  return lcps.filter((l) => passes.has(String(l.id_creneau)) && statut(l) === "non_renseigne").length;
}

export function registerQualiteTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "controle_bpf",
    {
      description:
        "Repère les sessions d'un exercice exclues ou mal renseignées pour le BPF : « inclure dans le BPF » décoché, étape non " +
        "confirmée (détection d'après le nom de l'étape : la configuration « confirmée » n'est pas exposée par l'API), sans " +
        "financement, présences manquantes sur les créneaux passés, objectif ou spécialité vides. Ne produit pas les chiffres du BPF.",
      inputSchema: { ...PERIODE_SCHEMA, verifier_presences: z.boolean().default(true).describe("Lit les présences session par session (plus lent)") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { du, au } = periode(args);
      const sessions = await sessionsPeriode(client, du, au);
      const etapes = new Map((await client.list("etapes.php")).map((e) => [String(e.id_etape_process), String(e.intitule)]));
      const ids = sessions.map((s) => String(s.id_action_de_formation));
      const financements: Row[] = [];
      const lams: Row[] = [];
      for (const l of lots(ids)) {
        financements.push(...(await client.list("financements.php", { id_action_de_formation: l.join(",") })));
        lams.push(...(await client.list("lams.php", { id_action_de_formation: l.join(",") })));
      }
      const modules = new Map<string, Row>();
      const idsModules = [...new Set(lams.map((l) => String(l.id_module)))];
      for (const l of lots(idsModules)) for (const m of await client.list("modules.php", { id: l.join(","), fields: "id_module,id_specialite,include_in_bpf" })) modules.set(String(m.id_module), m);
      const financees = new Set(financements.map((f) => String(f.id_action_de_formation)));
      const resultats: { session: string; anomalies: string[] }[] = [];
      for (const s of sessions) {
        const id = String(s.id_action_de_formation);
        const anomalies: string[] = [];
        const etape = etapes.get(String(s.id_etape_process)) ?? "";
        if (!vrai(s.include_in_bpf)) anomalies.push("« Inclure dans le BPF » décoché : session absente du BPF");
        if (ETAPE_NON_CONFIRMEE.test(normalize(etape))) anomalies.push(`Étape « ${etape} » probablement non confirmée : session comptée hors BPF`);
        if (!financees.has(id) && num(s.nb_participants_inscrits) > 0) anomalies.push("Aucun financement saisi");
        if (!s.objectif) anomalies.push("Objectif général vide");
        const mods = lams.filter((l) => String(l.id_action_de_formation) === id).map((l) => modules.get(String(l.id_module)));
        if (mods.some((m) => !m || !m.id_specialite || String(m.id_specialite) === "0")) anomalies.push("Spécialité de formation manquante sur un module");
        if (args.verifier_presences && String(s.date_fin) < `${today()} 23:59:59` && num(s.nb_participants_inscrits) > 0) {
          const n = await presencesManquantes(client, id);
          if (n > 0) anomalies.push(`${n} présence(s) non renseignée(s) sur des créneaux passés`);
        }
        if (anomalies.length) resultats.push({ session: label(s), anomalies });
      }
      return json({ periode: `${du} → ${au}`, sessions_controlees: sessions.length, sessions_a_corriger: resultats.length, resultats });
    },
  );

  server.registerTool(
    "controle_statuts_bpf",
    {
      description:
        "Participants dont le statut BPF est « non renseigné », et entreprises dont le nom ressemble à un financeur " +
        "(France Travail, OPCO, région…) qui devraient être saisies comme financeurs externes plutôt que comme clients.",
      inputSchema: { limite: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const [participants, entreprises] = await Promise.all([
        client.list("participants.php", { fields: "id_participant,prenom,nom,email,statut_bpf,id_entreprise" }),
        client.list("entreprises.php", { fields: "id_entreprise,raison_sociale,numero_complet" }),
      ]);
      const sansStatut = participants.filter((p) => !p.statut_bpf || /non.?renseign/.test(normalize(p.statut_bpf)));
      const suspectes = entreprises.filter((e) => LIBELLE_FINANCEUR.test(normalize(e.raison_sociale)));
      return json({
        participants_sans_statut_bpf: sansStatut.length,
        participants: sansStatut.slice(0, args.limite).map((p) => ({ id_participant: p.id_participant, nom: nomDe(p), email: p.email || undefined })),
        entreprises_ressemblant_a_un_financeur: suspectes.slice(0, args.limite).map((e) => ({ id_entreprise: e.id_entreprise, raison_sociale: e.raison_sociale })),
        conseil: "Un OPCO ou France Travail doit être créé comme financeur externe (cadre BPF correct), pas comme entreprise cliente.",
      });
    },
  );

  server.registerTool(
    "sous_traitance",
    {
      description:
        "Lecture : intervenants extérieurs (formateurs « exterieur », entreprise sous-traitante) et financements de type " +
        "sous-traitance sur une période. Écriture : bascule le statut BPF d'un formateur d'une session entre intérieur et " +
        "extérieur (dry_run=true par défaut ; ne relancer avec dry_run=false qu'après confirmation explicite).",
      inputSchema: {
        ...PERIODE_SCHEMA,
        session: SESSION.optional().describe("Avec `statut_bpf` : session concernée"),
        formateur: z.string().optional().describe("Avec `statut_bpf` : prénom et nom ou id du formateur"),
        statut_bpf: z.enum(["interieur", "exterieur"]).optional().describe("Nouveau statut BPF du formateur sur cette session"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      if (args.statut_bpf) {
        if (!args.session || !args.formateur) return json({ erreur: "session et formateur requis pour changer le statut BPF." });
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        const lafs = await client.list("lafs.php", { id_action_de_formation: String(s.row.id_action_de_formation), include: "formateur" });
        const cible = normalize(args.formateur);
        const trouves = lafs.filter((l) => {
          const f = (l.formateur ?? {}) as Row;
          return String(l.id_formateur) === args.formateur || String(l.id_laf) === args.formateur || normalize(`${f.prenom} ${f.nom}`) === cible || normalize(`${f.nom} ${f.prenom}`) === cible;
        });
        if (trouves.length !== 1) return json({ erreur: trouves.length ? "Formateur ambigu." : "Formateur non staffé sur cette session.", staffes: lafs.map((l) => nomDe(l.formateur) ?? l.id_formateur) });
        const laf = trouves[0];
        return appliquer(args.dry_run, { session: label(s.row), formateur: nomDe(laf.formateur) ?? laf.id_formateur, statut_bpf: { avant: laf.statut_bpf, apres: args.statut_bpf } }, () =>
          client.post("lafs.php", { id_laf: laf.id_laf, statut_bpf: args.statut_bpf }),
        );
      }
      const { du, au } = periode(args);
      const sessions = await sessionsPeriode(client, du, au);
      const ids = sessions.map((s) => String(s.id_action_de_formation));
      const lafs: Row[] = [];
      const financements: Row[] = [];
      for (const l of lots(ids)) {
        lafs.push(...(await client.list("lafs.php", { id_action_de_formation: l.join(","), include: "formateur" })));
        financements.push(...(await client.list("financements.php", { id_action_de_formation: l.join(",") })));
      }
      const parId = new Map(sessions.map((s) => [String(s.id_action_de_formation), s]));
      const externes = lafs
        .filter((l) => normalize(l.statut_bpf).startsWith("ext") || (l.id_entreprise_formateur && String(l.id_entreprise_formateur) !== "0"))
        .map((l) => ({ session: label(parId.get(String(l.id_action_de_formation)) ?? {}), formateur: nomDe(l.formateur) ?? l.id_formateur, statut_bpf: l.statut_bpf, id_entreprise_sous_traitante: l.id_entreprise_formateur || undefined }));
      const g = financements.filter((f) => normalize(f.type).includes("sous")).map((f) => ({ session: label(parId.get(String(f.id_action_de_formation)) ?? {}), id_financement: f.id_financement, montant: num(f.montant_total_finance) }));
      return json({ periode: `${du} → ${au}`, intervenants_exterieurs_cadre_f2: externes, financements_sous_traitance_cadre_g: g });
    },
  );

  server.registerTool(
    "dpc",
    {
      description:
        "Modules éligibles DPC, sessions sans numéro de session DPC et participants sans ADELI / RPPS pour une période. " +
        "Les numéros DPC se modifient avec `modifier_session` ou dans Dendreo.",
      inputSchema: PERIODE_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { du, au } = periode(args);
      const modules = await client.list("modules.php", { fields: "id_module,intitule,numero_complet,eligible_dpc,num_programme_dpc" });
      const dpc = modules.filter((m) => vrai(m.eligible_dpc));
      const idsDpc = new Set(dpc.map((m) => String(m.id_module)));
      const sessions = await sessionsPeriode(client, du, au);
      const sessionsDpc: Row[] = [];
      for (const s of sessions) {
        const lams = await client.list("lams.php", { id_action_de_formation: String(s.id_action_de_formation) });
        if (lams.some((l) => idsDpc.has(String(l.id_module)))) sessionsDpc.push(s);
      }
      const sansNumero = sessionsDpc.filter((s) => !s.num_session_dpc);
      const sansIdentifiant: { session: string; participant: string }[] = [];
      for (const s of sessionsDpc) {
        for (const l of await client.list("laps.php", { id_action_de_formation: String(s.id_action_de_formation), include: "participant" })) {
          const p = (l.participant ?? {}) as Row;
          if (!p.ogdpc_adeli && !p.ogdpc_rpps && !p.adeli_rpps) sansIdentifiant.push({ session: label(s), participant: nomDe(p) ?? String(l.id_participant) });
        }
      }
      return json({
        periode: `${du} → ${au}`,
        modules_eligibles_dpc: dpc.map((m) => ({ id_module: m.id_module, module: m.intitule, num_programme_dpc: m.num_programme_dpc || undefined })),
        sessions_dpc: sessionsDpc.length,
        sessions_sans_numero_session_dpc: sansNumero.map(label),
        participants_sans_adeli_rpps: sansIdentifiant,
      });
    },
  );

  server.registerTool(
    "qualite_crm",
    {
      description:
        "Détecte les doublons d'entreprises (SIRET, raison sociale), les entreprises sans contact principal ou sans contact " +
        "de facturation, et les participants sans email.",
      inputSchema: { limite: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const [entreprises, contacts, participants] = await Promise.all([
        client.list("entreprises.php", { fields: "id_entreprise,raison_sociale,siret,numero_complet" }),
        client.list("contacts.php"),
        client.list("participants.php", { fields: "id_participant,prenom,nom,email" }),
      ]);
      const groupes = (cle: (e: Row) => string) => {
        const m = new Map<string, Row[]>();
        for (const e of entreprises) {
          const k = cle(e);
          if (k) m.set(k, [...(m.get(k) ?? []), e]);
        }
        return [...m.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ valeur: k, entreprises: v.map((e) => ({ id_entreprise: e.id_entreprise, raison_sociale: e.raison_sociale })) }));
      };
      const contactsParEnt = new Map<string, Row[]>();
      for (const c of contacts) contactsParEnt.set(String(c.id_entreprise), [...(contactsParEnt.get(String(c.id_entreprise)) ?? []), c]);
      const sansPrincipal: Row[] = [];
      const sansFacturation: Row[] = [];
      for (const e of entreprises) {
        const cs = contactsParEnt.get(String(e.id_entreprise)) ?? [];
        if (cs.length === 0) continue;
        if (!cs.some((c) => vrai(c.principal ?? c.contact_principal))) sansPrincipal.push(e);
        if (!cs.some((c) => vrai(c.facturation ?? c.contact_facturation))) sansFacturation.push(e);
      }
      const brief = (rows: Row[]) => rows.slice(0, args.limite).map((e) => ({ id_entreprise: e.id_entreprise, raison_sociale: e.raison_sociale }));
      const sansEmail = participants.filter((p) => !p.email);
      return json({
        doublons_siret: groupes((e) => String(e.siret ?? "").replace(/\s/g, "")).slice(0, args.limite),
        doublons_raison_sociale: groupes((e) => normalize(e.raison_sociale)).slice(0, args.limite),
        entreprises_sans_contact_principal: { nombre: sansPrincipal.length, exemples: brief(sansPrincipal) },
        entreprises_sans_contact_facturation: { nombre: sansFacturation.length, exemples: brief(sansFacturation) },
        participants_sans_email: { nombre: sansEmail.length, exemples: sansEmail.slice(0, args.limite).map((p) => ({ id_participant: p.id_participant, nom: nomDe(p) })) },
        note: "Les doublons se fusionnent dans Dendreo : l'API ne le permet pas.",
      });
    },
  );

  server.registerTool(
    "controle_conformite_session",
    {
      description:
        "Avant de générer les attestations ou certificats : présences manquantes, émargements non signés, étape de la session, " +
        "et liste des participants éligibles (toutes présences saisies, aucune absence non justifiée).",
      inputSchema: { session: SESSION },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = single(await findSession(client, args.session, FIELDS_ADF), "Session");
      if (!("row" in s)) return json(s);
      const id = String(s.row.id_action_de_formation);
      const [laps, creneaux, lcps, etapes] = await Promise.all([
        client.list("laps.php", { id_action_de_formation: id, include: "participant" }),
        client.list("creneaux.php", { id_action_de_formation: id }),
        client.list("lcps.php", { id_action_de_formation: id }),
        client.list("etapes.php"),
      ]);
      const passes = new Set(creneaux.filter((c) => String(c.date_fin) < `${today()} 23:59:59`).map((c) => String(c.id_creneau)));
      const etape = etapes.find((e) => String(e.id_etape_process) === String(s.row.id_etape_process));
      const participants = laps.filter((l) => String(l.id_participant) !== "0").map((l) => {
        const mes = lcps.filter((p) => String(p.id_lap) === String(l.id_lap) && passes.has(String(p.id_creneau)));
        const manquantes = mes.filter((p) => statut(p) === "non_renseigne").length;
        const sansSignature = mes.filter((p) => statut(p) === "present" && !vrai(p.emargement_count)).length;
        const absNonJustifiees = mes.filter((p) => statut(p) === "absent_non_justifie").length;
        return { participant: nomDe(l.participant), presences_manquantes: manquantes, emargements_non_signes: sansSignature, absences_non_justifiees: absNonJustifiees, eligible: manquantes === 0 && absNonJustifiees === 0 };
      });
      return json({
        session: label(s.row),
        etape: etape?.intitule,
        creneaux_passes: passes.size,
        participants_eligibles: participants.filter((p) => p.eligible).map((p) => p.participant),
        participants_a_regulariser: participants.filter((p) => !p.eligible),
        avertissements: [
          ...(passes.size < creneaux.length ? [`${creneaux.length - passes.size} créneau(x) pas encore passé(s)`] : []),
          ...(participants.some((p) => p.emargements_non_signes) ? ["Des présences ne sont pas signées électroniquement (emargement_count = 0)."] : []),
        ],
      });
    },
  );

  server.registerTool(
    "validation_emargements",
    {
      description:
        "Créneaux passés où le formateur ou des participants n'ont pas signé (emargement_count = 0), sur une session ou une période.",
      inputSchema: {
        session: SESSION.optional(),
        du: DATE.optional().describe("Défaut : 30 jours avant aujourd'hui"),
        au: DATE.optional().describe("Défaut : aujourd'hui"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const au = args.au ?? today();
      const du = args.du ?? new Date(Date.parse(`${au}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
      const query: Record<string, string> = { include: "lcfs,lcps" };
      let titre: string | undefined;
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        query.id_action_de_formation = String(s.row.id_action_de_formation);
        titre = label(s.row);
      } else {
        query.started_after = du;
        query.started_before = `${au} 23:59:59`;
      }
      const creneaux = (await client.list("creneaux.php", query)).filter((c) => String(c.date_fin) < `${today()} 23:59:59`);
      const resultats = creneaux
        .map((c) => {
          const lcfs = ((c.lcfs ?? []) as Row[]).filter((l) => String(l.status ?? "1") === "1");
          const lcps = ((c.lcps ?? []) as Row[]).filter((l) => vrai(l.presence));
          const formateurs = lcfs.filter((l) => !vrai(l.emargement_count)).length;
          const participants = lcps.filter((l) => !vrai(l.emargement_count)).length;
          const d = splitDateTime(c.date_debut);
          return { session: c.id_action_de_formation, id_creneau: c.id_creneau, date: d.date, heure: d.heure, formateurs_sans_signature: formateurs, participants_sans_signature: participants };
        })
        .filter((r) => r.formateurs_sans_signature || r.participants_sans_signature);
      return json({ session: titre, periode: args.session ? undefined : `${du} → ${au}`, creneaux_a_valider: resultats.length, resultats });
    },
  );
}
