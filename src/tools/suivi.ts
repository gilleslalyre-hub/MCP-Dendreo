import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DendreoError, type DendreoClient, type Row } from "../dendreo/client.js";
import {
  findFormateur,
  findInscription,
  findModule,
  findSession,
  inscriptionsSession,
  single,
} from "./resolve.js";
import { json, nomDe, splitDateTime, today, vrai } from "./util.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SESSION = z.string().describe("Id de l'action de formation ou numéro complet (ADF_…)");

const slotLabel = (c: Row | undefined) => {
  if (!c) return "créneau inconnu";
  const d = splitDateTime(c.date_debut);
  return `${d.date} ${d.heure}-${splitDateTime(c.date_fin).heure}`;
};

const nomLap = (l: Row | undefined) =>
  nomDe(l?.participant) ?? (l && String(l.id_participant) === "0" ? "Participant non identifié" : `lap ${l?.id_lap}`);

/** État d'une présence : présent, absent (justifié ou non), ou non renseigné. */
export function statut(lcp: Row): "present" | "absent_justifie" | "absent_non_justifie" | "non_renseigne" {
  if (vrai(lcp.presence)) return "present";
  if (Number(lcp.total_heures_absence ?? 0) > 0 || String(lcp.presence) === "0") {
    return vrai(lcp.justified) ? "absent_justifie" : "absent_non_justifie";
  }
  return "non_renseigne";
}

const round = (n: number) => Math.round(n * 100) / 100;

async function sessionOuErreur(client: DendreoClient, session: string) {
  return single(
    await findSession(client, session, "id_action_de_formation,numero_complet,intitule,type,date_debut,date_fin"),
    "Session",
  );
}

const sessionLabel = (adf: Row) => `${adf.numero_complet} — ${adf.intitule}`;

export function registerSuiviTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "feuille_presence",
    {
      title: "Feuille de présence d'une session",
      description:
        "Présences et absences de chaque participant sur chaque créneau d'une action de formation : heures suivies, " +
        "taux d'assiduité, absences justifiées ou non, créneaux passés sans présence renseignée.",
      inputSchema: {
        session: SESSION,
        participant: z.string().optional().describe("Limiter à un participant : prénom et nom, email ou id"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const [laps, creneaux, lcps] = await Promise.all([
        inscriptionsSession(client, idAdf),
        client.list("creneaux.php", { id_action_de_formation: idAdf }),
        client.list("lcps.php", { id_action_de_formation: idAdf }),
      ]);
      let cibles = laps;
      if (args.participant) {
        cibles = findInscription(laps, args.participant);
        if (cibles.length === 0) return json({ erreur: "Participant non inscrit à cette session.", inscrits: laps.map(nomLap) });
      }
      const creneauById = new Map(creneaux.map((c) => [String(c.id_creneau), c]));
      const maintenant = `${today()} 23:59:59`;

      const participants = cibles.map((lap) => {
        const siens = lcps.filter((p) => String(p.id_lap) === String(lap.id_lap));
        let heuresPresence = 0;
        let heuresAbsence = 0;
        const absences: string[] = [];
        const nonRenseignes: string[] = [];
        const detail = siens
          .map((p) => {
            const c = creneauById.get(String(p.id_creneau));
            const st = statut(p);
            heuresPresence += Number(p.total_heures_presence ?? 0);
            heuresAbsence += Number(p.total_heures_absence ?? 0);
            if (st.startsWith("absent")) absences.push(`${slotLabel(c)}${p.justification ? ` (${p.justification})` : ""}`);
            if (st === "non_renseigne" && c && String(c.date_fin) <= maintenant) nonRenseignes.push(slotLabel(c));
            return { creneau: slotLabel(c), statut: st, heures_presence: p.total_heures_presence };
          })
          .sort((a, b) => a.creneau.localeCompare(b.creneau));
        const total = heuresPresence + heuresAbsence;
        return {
          participant: nomLap(lap),
          id_lap: lap.id_lap,
          heures_presence: round(heuresPresence),
          heures_absence: round(heuresAbsence),
          assiduite: total > 0 ? `${Math.round((heuresPresence / total) * 100)} %` : undefined,
          absences,
          creneaux_passes_non_renseignes: nonRenseignes,
          detail,
        };
      });
      return json({ session: sessionLabel(s.row), nb_creneaux: creneaux.length, participants });
    },
  );

  server.registerTool(
    "saisir_presences",
    {
      title: "Saisir des présences ou absences",
      description:
        "Marque des participants présents ou absents (absence justifiée ou non, présence partielle en heures) sur des " +
        "créneaux d'une action de formation. Un créneau déjà émargé électroniquement est refusé par Dendreo.",
      inputSchema: {
        session: SESSION,
        participants: z
          .array(z.string())
          .optional()
          .describe("Participants concernés (prénom et nom, email ou id). Par défaut tous les inscrits"),
        jours: z.array(DATE).optional().describe("Jours concernés (AAAA-MM-JJ). Par défaut tous les créneaux passés"),
        id_creneaux: z.array(z.string()).optional().describe("Créneaux précis (id), à la place de jours"),
        presence: z.enum(["present", "absent"]),
        justifiee: z.boolean().optional().describe("Pour une absence : justifiée ou non (défaut non)"),
        justification: z.string().optional().describe("Motif de l'absence"),
        duree_heures: z.number().positive().optional().describe("Présence ou absence partielle, en heures"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const [laps, creneaux] = await Promise.all([
        inscriptionsSession(client, idAdf),
        client.list("creneaux.php", { id_action_de_formation: idAdf }),
      ]);

      let cibles = laps;
      const introuvables: string[] = [];
      if (args.participants?.length) {
        cibles = [];
        for (const q of args.participants) {
          const found = findInscription(laps, q);
          if (found.length === 1) cibles.push(found[0]);
          else introuvables.push(`${q} : ${found.length === 0 ? "non inscrit" : "ambigu"}`);
        }
      }
      const maintenant = `${today()} 23:59:59`;
      let slots = creneaux;
      if (args.id_creneaux?.length) slots = creneaux.filter((c) => args.id_creneaux!.includes(String(c.id_creneau)));
      else if (args.jours?.length) slots = creneaux.filter((c) => args.jours!.includes(splitDateTime(c.date_debut).date));
      else slots = creneaux.filter((c) => String(c.date_fin) <= maintenant);
      slots = [...slots].sort((a, b) => String(a.date_debut).localeCompare(String(b.date_debut)));

      const body = (c: Row, lap: Row): Row => ({
        id_creneau: c.id_creneau,
        id_lap: lap.id_lap,
        presence: args.presence === "present" ? 1 : 0,
        ...(args.presence === "absent" ? { justified: args.justifiee ? 1 : 0 } : {}),
        ...(args.justification ? { justification: args.justification } : {}),
        ...(args.duree_heures ? { duree: args.duree_heures } : {}),
      });
      const recap = {
        session: sessionLabel(s.row),
        saisie: args.presence === "present" ? "présent" : `absent ${args.justifiee ? "justifié" : "non justifié"}`,
        participants: cibles.map(nomLap),
        creneaux: slots.map(slotLabel),
        nb_saisies: cibles.length * slots.length,
        ...(introuvables.length ? { introuvables } : {}),
        ...(slots.some((c) => String(c.date_debut) > maintenant)
          ? { avertissement: "Certains créneaux ne sont pas encore passés." }
          : {}),
      };
      if (args.dry_run || recap.nb_saisies === 0) return json({ dry_run: args.dry_run, ...recap });

      const journal: string[] = [];
      for (const lap of cibles) {
        for (const c of slots) {
          try {
            await client.post("lcps.php", body(c, lap));
            journal.push(`${nomLap(lap)} — ${slotLabel(c)} : ok`);
          } catch (e) {
            const refus = e instanceof DendreoError && e.status === 422;
            journal.push(`${nomLap(lap)} — ${slotLabel(c)} : ${refus ? "refusé (créneau probablement émargé)" : "erreur"} : ${(e as Error).message}`);
          }
        }
      }
      return json({ ...recap, journal });
    },
  );

  server.registerTool(
    "taches_en_attente",
    {
      title: "Tâches en attente des participants",
      description:
        "Ce qui reste à faire sur l'extranet des participants d'une session (ou d'un participant) : émargements " +
        "électroniques en cours, documents à signer, questionnaires de satisfaction et d'auto-positionnement non remplis. " +
        "Renvoie les liens à transmettre pour une relance.",
      inputSchema: {
        session: SESSION.optional(),
        id_participant: z.string().optional().describe("À la place de session : id d'un participant"),
        types: z
          .array(z.enum(["esignature", "esignature-doc", "satisfaction", "auto-positionnement"]))
          .optional()
          .describe("Limiter à ces types de tâches"),
        autologin: z.boolean().default(false).describe("Liens avec connexion automatique à l'extranet"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let ids: string[];
      let idAdf: string | undefined;
      let noms = new Map<string, string | undefined>();
      let label: string | undefined;
      if (args.session) {
        const s = await sessionOuErreur(client, args.session);
        if (!("row" in s)) return json(s);
        idAdf = String(s.row.id_action_de_formation);
        label = sessionLabel(s.row);
        const laps = (await inscriptionsSession(client, idAdf)).filter((l) => String(l.id_participant) !== "0");
        ids = laps.map((l) => String(l.id_participant));
        noms = new Map(laps.map((l) => [String(l.id_participant), nomLap(l)]));
      } else if (args.id_participant) {
        ids = [args.id_participant];
      } else {
        return json({ erreur: "Préciser une session ou un id_participant." });
      }
      if (ids.length === 0) return json({ session: label, participants: [] });

      const rows = await client.list("taches.php", {
        id: ids.join(","),
        types: args.types?.join(","),
        autologin: args.autologin ? 1 : undefined,
      });
      const participants = rows
        .map((r) => {
          const taches = ((r.taches ?? []) as Row[]).filter((t) => !idAdf || String(t.id_adf) === idAdf);
          return {
            participant: noms.get(String(r.id_participant)) ?? r.id_participant,
            id_participant: r.id_participant,
            taches: taches.map((t) => ({
              type: t.type,
              intitule: t.questionnaire_type ?? t.positionnement_type ?? t.intitule,
              creneau: t.creneau_date_debut ? `${t.creneau_date_debut} → ${String(t.creneau_date_fin).slice(11, 16)}` : undefined,
              id_adf: idAdf ? undefined : t.id_adf,
              url: t.url,
            })),
          };
        })
        .filter((p) => p.taches.length > 0);
      return json({ session: label, nb_participants_concernes: participants.length, participants });
    },
  );

  server.registerTool(
    "emargements_manquants",
    {
      title: "Émargements et présences manquants",
      description:
        "Liste, pour une session ou pour toutes les sessions d'une période, les créneaux passés dont la présence " +
        "n'est pas renseignée pour certains participants, avec les émargements électroniques encore ouverts.",
      inputSchema: {
        session: SESSION.optional(),
        du: DATE.optional().describe("Sans session : début de la période (défaut : 30 jours avant aujourd'hui)"),
        au: DATE.optional().describe("Sans session : fin de la période (défaut : aujourd'hui)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let adfs: Row[];
      if (args.session) {
        const s = await sessionOuErreur(client, args.session);
        if (!("row" in s)) return json(s);
        adfs = [s.row];
      } else {
        const au = args.au ?? today();
        const du = args.du ?? new Date(Date.parse(`${au}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
        const creneaux = await client.list("creneaux.php", { started_after: du, started_before: `${au} 23:59:59` });
        const ids = [...new Set(creneaux.map((c) => String(c.id_action_de_formation)))];
        adfs = ids.length
          ? await client.list("actions_de_formation.php", { id: ids.join(","), fields: "id_action_de_formation,numero_complet,intitule" })
          : [];
      }
      const maintenant = `${today()} 23:59:59`;
      const sessions = [];
      for (const adf of adfs) {
        const idAdf = String(adf.id_action_de_formation);
        const [laps, creneaux, lcps] = await Promise.all([
          inscriptionsSession(client, idAdf),
          client.list("creneaux.php", { id_action_de_formation: idAdf }),
          client.list("lcps.php", { id_action_de_formation: idAdf }),
        ]);
        const lapById = new Map(laps.map((l) => [String(l.id_lap), l]));
        const manquants = creneaux
          .filter((c) => String(c.date_fin) <= maintenant)
          .map((c) => ({
            creneau: slotLabel(c),
            participants: lcps
              .filter((p) => String(p.id_creneau) === String(c.id_creneau) && statut(p) === "non_renseigne")
              .map((p) => nomLap(lapById.get(String(p.id_lap)))),
          }))
          .filter((c) => c.participants.length > 0)
          .sort((a, b) => a.creneau.localeCompare(b.creneau));
        if (manquants.length) sessions.push({ session: sessionLabel(adf), creneaux: manquants });
      }
      return json({ nb_sessions: sessions.length, sessions });
    },
  );

  server.registerTool(
    "evaluations_session",
    {
      title: "Évaluations des participants d'une session",
      description:
        "Résultats des participants d'une action de formation : réussite par module, note, appréciation et niveau " +
        "d'acquisition de chaque compétence (acquis, en cours, non acquis).",
      inputSchema: { session: SESSION },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const [evals, lmps] = await Promise.all([
        client.list("evaluations.php", { id_action_de_formation: idAdf, include: "competences,participant" }),
        client.list("lmps.php", { id_action_de_formation: idAdf, include: "participant,module" }),
      ]);
      const note = (e: Row) => (e.note !== "" && e.note != null ? `${Number(e.note)}/${e.amplitude_notation}` : undefined);
      const resultats = lmps
        .filter((m) => vrai(m.inscription ?? 1))
        .map((m) => {
          const siennes = evals.filter((e) => String(e.id_lmp) === String(m.id_lmp));
          const valide = m.validated ?? siennes.find((e) => e.validated !== "")?.validated;
          return {
            participant: nomDe(m.participant) ?? `participant ${m.id_participant}`,
            module: ((m.module ?? {}) as Row).intitule ?? m.id_module,
            reussite: valide === "" || valide == null ? "non évalué" : vrai(valide) ? "validé" : "non validé",
            evaluations: siennes.map((e) => ({
              nom: e.evaluation_name || undefined,
              note: note(e),
              appreciation: e.appreciation || undefined,
              competences: ((e.competences ?? []) as Row[]).map((c) => {
                const ev = (c.evaluation ?? {}) as Row;
                return { competence: c.label, statut: ev.status || "non évaluée", note: note(ev) };
              }),
            })),
          };
        });
      const evalues = resultats.filter((r) => r.reussite !== "non évalué");
      return json({
        session: sessionLabel(s.row),
        taux_reussite: evalues.length
          ? `${Math.round((evalues.filter((r) => r.reussite === "validé").length / evalues.length) * 100)} %`
          : undefined,
        resultats,
      });
    },
  );

  server.registerTool(
    "evaluer_participant",
    {
      title: "Évaluer un participant",
      description:
        "Enregistre l'évaluation d'un participant sur un module d'une session (réussite, note, appréciation) ou sur une " +
        "compétence (acquis, en cours, non acquis). Par défaut dry_run=true : rien n'est écrit. " +
        "Ne relancer avec dry_run=false qu'après confirmation explicite.",
      inputSchema: {
        session: SESSION,
        participant: z.string().describe("Prénom et nom, email ou id du participant"),
        module: z.string().optional().describe("Module évalué (intitulé ou id) si la session en a plusieurs"),
        valide: z.boolean().optional().describe("Réussite du participant au module"),
        note: z.number().optional(),
        note_sur: z.number().int().optional().describe("Barème de la note, ex. 20"),
        appreciation: z.string().optional(),
        id_competence: z.string().optional().describe("Évaluer une compétence du module plutôt que le module"),
        statut_competence: z.enum(["acquis", "en-cours", "non-acquis"]).optional(),
        formateur: z.string().optional().describe("Formateur évaluateur : prénom et nom, ou id"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const laps = await inscriptionsSession(client, idAdf);
      const p = single(findInscription(laps, args.participant), "Participant");
      if (!("row" in p)) return json({ ...p, candidats: p.candidats.map(nomLap) });

      const lmps = await client.list("lmps.php", {
        id_action_de_formation: idAdf,
        id_participant: String(p.row.id_participant),
        include: "module",
      });
      let lmp: Row | undefined;
      if (args.module) {
        const mods = await findModule(client, args.module);
        const ids = new Set(mods.map((m) => String(m.id_module)));
        const found = lmps.filter((l) => ids.has(String(l.id_module)));
        if (found.length !== 1) return json({ erreur: "Module introuvable ou ambigu dans cette session.", modules: lmps.map((l) => ((l.module ?? {}) as Row).intitule) });
        lmp = found[0];
      } else if (lmps.length === 1) {
        lmp = lmps[0];
      } else {
        return json({ erreur: "Préciser le module évalué.", modules: lmps.map((l) => ((l.module ?? {}) as Row).intitule) });
      }

      const body: Row = { id_lmp: lmp.id_lmp };
      if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        body.id_formateur = f.row.id_formateur;
      }
      if (args.id_competence) body.id_competence = args.id_competence;
      if (args.statut_competence) body.status = args.statut_competence;
      if (args.valide !== undefined) body.validated = args.valide ? 1 : 0;
      if (args.note !== undefined) body.note = args.note;
      if (args.note_sur !== undefined) body.amplitude_notation = args.note_sur;
      if (args.appreciation !== undefined) body.appreciation = args.appreciation;

      const recap = {
        session: sessionLabel(s.row),
        participant: nomLap(p.row),
        module: ((lmp.module ?? {}) as Row).intitule ?? lmp.id_module,
        evaluation: body,
      };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      const resultat = await client.post("evaluations.php", body);
      return json({ ok: true, ...recap, resultat });
    },
  );

  server.registerTool(
    "satisfaction",
    {
      title: "Résultats des questionnaires de satisfaction",
      description:
        "Synthèse des réponses aux questionnaires de satisfaction pour une session, un formateur ou un module : " +
        "note moyenne par question (en % et sur le barème), nombre de réponses et commentaires libres.",
      inputSchema: {
        session: SESSION.optional(),
        formateur: z.string().optional().describe("Prénom et nom, ou id"),
        formation: z.string().optional().describe("Module : intitulé, MOD_… ou id"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const query: Record<string, string> = {};
      const filtres: Record<string, unknown> = {};
      if (args.session) {
        const s = await sessionOuErreur(client, args.session);
        if (!("row" in s)) return json(s);
        query.id_action_de_formation = String(s.row.id_action_de_formation);
        filtres.session = sessionLabel(s.row);
      }
      if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        query.id_formateur = String(f.row.id_formateur);
        filtres.formateur = `${f.row.prenom} ${f.row.nom}`;
      }
      if (args.formation) {
        const m = single(await findModule(client, args.formation), "Formation");
        if (!("row" in m)) return json(m);
        query.id_module = String(m.row.id_module);
        filtres.formation = m.row.intitule;
      }
      if (Object.keys(query).length === 0) return json({ erreur: "Préciser une session, un formateur ou une formation." });

      const reponses = await client.list("reponses_questionnaire_satisfaction.php", query);
      const questions = new Map<string, { notes: number[]; normalises: number[]; amplitude: unknown; textes: string[] }>();
      for (const r of reponses) {
        const q = String(r.intitule_question ?? r.id_question_satisfaction);
        const agg = questions.get(q) ?? { notes: [], normalises: [], amplitude: r.amplitude_notation, textes: [] };
        if (r.note !== "" && r.note != null) agg.notes.push(Number(r.note));
        if (r.notation_normalise !== "" && r.notation_normalise != null) agg.normalises.push(Number(r.notation_normalise));
        if (r.texte) agg.textes.push(String(r.texte));
        questions.set(q, agg);
      }
      const moyenne = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
      const parQuestion = [...questions.entries()].map(([question, a]) => ({
        question,
        nb_reponses: Math.max(a.notes.length, a.textes.length),
        moyenne: a.notes.length ? `${moyenne(a.notes)}/${a.amplitude}` : undefined,
        moyenne_pourcent: moyenne(a.normalises),
        commentaires: a.textes.length ? a.textes : undefined,
      }));
      const tous = [...questions.values()].flatMap((a) => a.normalises);
      const norm = (r: Row) => (r.notation_normalise !== "" && r.notation_normalise != null ? Number(r.notation_normalise) : undefined);
      const moyenneDe = (rows: Row[]) => moyenne(rows.map(norm).filter((n): n is number => n !== undefined));

      const parModule = new Map<string, Row[]>();
      for (const r of reponses) {
        const m = (r.module ?? {}) as Row;
        const k = String(m.intitule ?? r.id_lam ?? "?");
        parModule.set(k, [...(parModule.get(k) ?? []), r]);
      }
      const lafs = query.id_action_de_formation ? await client.list("lafs.php", { id_action_de_formation: query.id_action_de_formation, include: "formateur" }) : [];
      const nomLaf = (id: string) => nomDe(lafs.find((l) => String(l.id_laf) === id)?.formateur) ?? `intervention formateur ${id}`;
      const parFormateur = new Map<string, Row[]>();
      for (const r of reponses) {
        if (!r.id_laf || String(r.id_laf) === "0") continue;
        const k = nomLaf(String(r.id_laf));
        parFormateur.set(k, [...(parFormateur.get(k) ?? []), r]);
      }

      let tauxReponse: Record<string, unknown> | undefined;
      if (args.session && query.id_action_de_formation) {
        const laps = (await inscriptionsSession(client, query.id_action_de_formation)).filter((l) => String(l.id_participant) !== "0");
        const repondants = new Set(
          reponses.filter((r) => String(r.owner_type ?? "").endsWith("Lap")).map((r) => String(r.owner_id)),
        );
        const repondantsParticipants = new Set(reponses.map((r) => String(((r.participant ?? {}) as Row).id_participant ?? "")));
        const aRepondu = (l: Row) => repondants.has(String(l.id_lap)) || repondantsParticipants.has(String(l.id_participant));
        tauxReponse = {
          inscrits: laps.length,
          repondants: laps.filter(aRepondu).length,
          taux_pourcent: laps.length ? Math.round((laps.filter(aRepondu).length / laps.length) * 100) : undefined,
          non_repondants: laps.filter((l) => !aRepondu(l)).map(nomLap),
        };
      }
      return json({
        filtres,
        nb_reponses: reponses.length,
        satisfaction_globale_pourcent: moyenne(tous),
        ...(tauxReponse ? { taux_de_reponse: tauxReponse } : {}),
        par_module: [...parModule.entries()].map(([module, rows]) => ({ module, nb_reponses: rows.length, moyenne_pourcent: moyenneDe(rows) })),
        ...(parFormateur.size ? { par_formateur: [...parFormateur.entries()].map(([formateur, rows]) => ({ formateur, nb_reponses: rows.length, moyenne_pourcent: moyenneDe(rows) })) } : {}),
        questions: parQuestion,
      });
    },
  );

  server.registerTool(
    "appreciations_negatives",
    {
      title: "Appréciations négatives",
      description:
        "Notes sous un seuil (en % de satisfaction) et commentaires libres sur les sessions d'une période, avec le " +
        "participant, le module et la question, pour alimenter le plan d'amélioration continue.",
      inputSchema: {
        du: DATE.optional().describe("Début de période, sur la date de début de session (défaut : 90 jours avant aujourd'hui)"),
        au: DATE.optional().describe("Fin de période (défaut : aujourd'hui)"),
        seuil_pourcent: z.number().min(0).max(100).default(60).describe("Notes strictement inférieures à ce seuil"),
        avec_commentaires: z.boolean().default(true).describe("Inclure aussi les commentaires libres des notes sous le seuil uniquement"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const au = args.au ?? today();
      const du = args.du ?? new Date(Date.parse(`${au}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
      const adfs = await client.list("actions_de_formation.php", { started_after: du, started_before: `${au} 23:59:59`, fields: "id_action_de_formation,numero_complet,intitule" });
      const nomAdf = new Map(adfs.map((a) => [String(a.id_action_de_formation), sessionLabel(a)]));
      const reponses: Row[] = [];
      for (let i = 0; i < adfs.length; i += 50) {
        reponses.push(...(await client.list("reponses_questionnaire_satisfaction.php", { id_action_de_formation: adfs.slice(i, i + 50).map((a) => a.id_action_de_formation).join(",") })));
      }
      const negatives = reponses
        .filter((r) => r.notation_normalise !== "" && r.notation_normalise != null && Number(r.notation_normalise) < args.seuil_pourcent)
        .map((r) => ({
          session: nomAdf.get(String(r.id_action_de_formation)) ?? r.id_action_de_formation,
          module: ((r.module ?? {}) as Row).intitule,
          question: r.intitule_question,
          note: `${r.note}/${r.amplitude_notation}`,
          pourcent: Number(r.notation_normalise),
          participant: nomDe(r.participant),
          commentaire: args.avec_commentaires ? r.texte || undefined : undefined,
        }))
        .sort((a, b) => a.pourcent - b.pourcent);
      return json({ periode: `${du} → ${au}`, seuil_pourcent: args.seuil_pourcent, nb_reponses_analysees: reponses.length, nb_appreciations_negatives: negatives.length, appreciations: negatives });
    },
  );

  server.registerTool(
    "relancer_satisfaction",
    {
      title: "Relances des questionnaires de satisfaction",
      description:
        "Non-répondants aux questionnaires de satisfaction (à chaud ou à froid) d'une session, avec leur lien de connexion " +
        "automatique à l'extranet pour la relance. L'API ne permet pas d'envoyer l'email : transmettre les liens depuis Dendreo ou à la main.",
      inputSchema: { session: SESSION },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = await sessionOuErreur(client, args.session);
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const laps = (await inscriptionsSession(client, idAdf)).filter((l) => String(l.id_participant) !== "0");
      if (laps.length === 0) return json({ session: sessionLabel(s.row), non_repondants: [] });
      const rows = await client.list("taches.php", { id: laps.map((l) => l.id_participant).join(","), types: "satisfaction", autologin: 1 });
      const noms = new Map(laps.map((l) => [String(l.id_participant), nomLap(l)]));
      const non_repondants = rows
        .map((r) => ({
          participant: noms.get(String(r.id_participant)) ?? r.id_participant,
          questionnaires: ((r.taches ?? []) as Row[])
            .filter((t) => String(t.id_adf) === idAdf)
            .map((t) => ({ questionnaire: t.questionnaire_type ?? t.intitule, url: t.url })),
        }))
        .filter((p) => p.questionnaires.length > 0);
      return json({ session: sessionLabel(s.row), inscrits: laps.length, nb_non_repondants: non_repondants.length, non_repondants });
    },
  );
}
