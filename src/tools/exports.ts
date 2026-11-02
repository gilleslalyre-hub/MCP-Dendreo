import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { DATE, arrondi, heuresCreneau, json, lots, num, today } from "./util.js";


/** Au-delà, un export CSV est renvoyé en pièce jointe plutôt qu'en texte. */
const MAX_TEXTE = 20_000;

/** Slugs connus, renvoyés uniquement quand l'export demandé échoue (évite ~600 tokens par conversation). */
const SLUGS_EXPORT = [
  "Activité : actions-de-formation, actions-de-formation-date-fin, creneaux, creneaux-participants (présents uniquement, ADF confirmées), creneaux-participants-all (tous), conflits, events, occupation-salles, a-d-f-et-salles-par-jour",
  "Modules / participants : modules, modules-adfs, modules-participants, participants-adfs, participants-formes, participants-formes-par-module, participants-par-module, participants-uniques-par-annee, participants-par-ajout, participants-avec-entreprise, newsletter",
  "Formateurs : creneaux-formateurs, interventions-formateurs, modules-realises-par-les-formateurs, notes-de-frais",
  "BPF : bpf-financements, bpf-formateurs, b-p-f-formations-sous-traitees, bpf-participants, bpf-participants-sous-traitance, bpf-participants-specialites",
  "Finance : budgets-adfs, c-a-facture-par-maison-mere, c-a-encaisse-par-mois, ca-facture-par-destinataire, ca-facture-par-mois, ca-facture-par-mois-par-adf, ca-facture-par-entreprise, analyse-delais-paiement, factures, facture-avec-marge, factures-detail, factures-adf, production-commerciaux",
  "Qualité : checklists-adfs, checklists-fiches-formateurs, checklists-interventions-formateurs, competences-participants, evaluations, auto-positionnement, moyenne-ap-par-adf, quiz, quiz-notes-globales, satisfaction-formateur, satisf-formateur-par-participant, export-satisfaction-participant, invitations-rsvp, log-emails",
  "Clients : contacts, entreprises-clientes, entreprises-clientes-emails, entreprises-clients-et-formations",
].join(" | ");

/** Renvoie un fichier téléchargé : texte pour un petit CSV, pièce jointe sinon. */
export function fichierResultat(doc: { contenu: Buffer; type: string; nom?: string }, nom: string, resume: Record<string, unknown>): CallToolResult {
  const texte = doc.type.includes("csv") || doc.type.startsWith("text/");
  if (texte) {
    const complet = doc.contenu.toString("utf8");
    if (doc.contenu.length <= MAX_TEXTE) {
      return { content: [{ type: "text", text: JSON.stringify({ ...resume, fichier: nom }) }, { type: "text", text: complet }] };
    }
    // CSV volumineux : on n'envoie que les premières lignes (le fichier complet reste téléchargeable en xlsx).
    const lignes = complet.split("\n");
    let garde = 0, taille = 0;
    while (garde < lignes.length && taille + lignes[garde].length + 1 <= MAX_TEXTE) taille += lignes[garde++].length + 1;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ...resume, fichier: nom, lignes_total: lignes.length - 1, lignes_affichees: Math.max(garde - 1, 0), tronque: true, taille_ko: Math.round(doc.contenu.length / 1024) }) },
        { type: "text", text: lignes.slice(0, garde).join("\n") },
      ],
    };
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ ...resume, fichier: nom, taille_ko: Math.round(doc.contenu.length / 1024) }) },
      { type: "resource", resource: { uri: `dendreo://exports/${encodeURIComponent(nom)}`, mimeType: doc.type, blob: doc.contenu.toString("base64") } },
    ],
  };
}

/** Sessions démarrant dans la période, avec inscrits et heures (créneaux de la période). */
async function activite(client: DendreoClient, du: string, au: string) {
  const sessions = await client.list("actions_de_formation.php", {
    started_after: du,
    started_before: `${au} 23:59:59`,
    fields: "id_action_de_formation,type",
  });
  const ids = sessions.map((s) => String(s.id_action_de_formation));
  const details: Row[] = [];
  for (const l of lots(ids)) {
    details.push(...(await client.list("actions_de_formation.php", { id: l.join(","), fields: "id_action_de_formation,type,nb_participants_inscrits,nb_participants_max" })));
  }
  const creneaux = await client.list("creneaux.php", { started_after: du, started_before: `${au} 23:59:59` });
  const heuresParAdf = new Map<string, number>();
  for (const c of creneaux) {
    const k = String(c.id_action_de_formation);
    heuresParAdf.set(k, (heuresParAdf.get(k) ?? 0) + heuresCreneau(c));
  }
  let inscrits = 0, places = 0, heuresStagiaires = 0, heures = 0;
  const parType: Record<string, number> = {};
  for (const d of details) {
    const n = num(d.nb_participants_inscrits);
    const h = heuresParAdf.get(String(d.id_action_de_formation)) ?? 0;
    inscrits += n;
    places += num(d.nb_participants_max);
    heures += h;
    heuresStagiaires += n * h;
    parType[String(d.type)] = (parType[String(d.type)] ?? 0) + 1;
  }
  const factures = await client.list("factures.php", { emission_after: du, emission_before: au });
  const parMois: Record<string, number> = {};
  let caHt = 0;
  for (const f of factures) {
    const m = String(f.date_emission).slice(0, 7);
    parMois[m] = arrondi((parMois[m] ?? 0) + num(f.montant_total_ht));
    caHt += num(f.montant_total_ht);
  }
  return {
    periode: `${du} → ${au}`,
    nb_sessions: details.length,
    sessions_par_type: parType,
    stagiaires_inscrits: inscrits,
    heures_formation: arrondi(heures),
    heures_stagiaires: arrondi(heuresStagiaires),
    taux_remplissage_pourcent: places ? arrondi((inscrits / places) * 100) : undefined,
    ca_facture_ht: arrondi(caHt),
    ca_facture_par_mois: parMois,
  };
}

const moisPrecedent = (date: string, annees: number) => `${Number(date.slice(0, 4)) - annees}${date.slice(4)}`;

export function registerExportTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "telecharger_export",
    {
      description:
        "Télécharge n'importe quel export du menu Reporting de Dendreo sur une période (`nom_export` = slug de l'export) " +
        "et renvoie le fichier (CSV en texte s'il est court, sinon pièce jointe). Slug inconnu : la liste des slugs est renvoyée.",
      inputSchema: {
        nom_export: z.string().describe("Slug de l'export, ex. creneaux, ca-facture-par-mois, bpf-participants"),
        date_debut: DATE,
        date_fin: DATE,
        type: z.enum(["csv", "xls", "xlsx"]).default("csv"),
        delimiter: z.enum([",", "|", ":", ";"]).default(";").describe("Séparateur CSV (ignoré hors CSV)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let doc;
      try {
        doc = await client.download("exports.php", {
          nom_export: args.nom_export,
          date_debut: args.date_debut,
          date_fin: args.date_fin,
          type: args.type,
          delimiter: args.type === "csv" ? args.delimiter : undefined,
        });
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}. Slugs disponibles : ${SLUGS_EXPORT}`);
      }
      const nom = doc.nom ?? `${args.nom_export}_${args.date_debut}_${args.date_fin}.${args.type}`;
      return fichierResultat(doc, nom, { export: args.nom_export, periode: `${args.date_debut} → ${args.date_fin}` });
    },
  );

  server.registerTool(
    "indicateurs_activite",
    {
      description:
        "Synthèse d'activité sur une période : sessions, stagiaires inscrits, heures de formation et heures-stagiaires " +
        "(estimées : inscrits × durée des créneaux de la période), taux de remplissage, CA facturé HT par mois. " +
        "`comparer_n_1=true` ajoute la même période un an plus tôt avec les écarts. Pour un chiffre exact, utiliser `telecharger_export`.",
      inputSchema: {
        du: DATE.optional().describe("Début (défaut : 1er janvier de l'année en cours)"),
        au: DATE.optional().describe("Fin (défaut : aujourd'hui)"),
        comparer_n_1: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const au = args.au ?? today();
      const du = args.du ?? `${au.slice(0, 4)}-01-01`;
      const [n, n1] = await Promise.all([
        activite(client, du, au),
        args.comparer_n_1 ? activite(client, moisPrecedent(du, 1), moisPrecedent(au, 1)) : Promise.resolve(undefined),
      ]);
      if (!n1) return json(n);
      const ecart = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? arrondi(a - b) : undefined);
      return json({
        ...n,
        n_moins_1: n1,
        ecarts: {
          nb_sessions: ecart(n.nb_sessions, n1.nb_sessions),
          stagiaires_inscrits: ecart(n.stagiaires_inscrits, n1.stagiaires_inscrits),
          heures_stagiaires: ecart(n.heures_stagiaires, n1.heures_stagiaires),
          ca_facture_ht: ecart(n.ca_facture_ht, n1.ca_facture_ht),
        },
      });
    },
  );

  server.registerTool(
    "pilotage_adf",
    {
      description:
        "Récapitulatif des sessions d'une période, groupées par étape et type (INTER / INTRA) : nombre de sessions, inscrits, " +
        "heures, montants financé / facturé / payé (d'après les financements). Le détail par session est renvoyé avec `detail=true`.",
      inputSchema: {
        du: DATE.optional().describe("Début (défaut : 1er janvier de l'année en cours)"),
        au: DATE.optional().describe("Fin (défaut : fin d'année)"),
        type: z.enum(["inter", "intra"]).optional(),
        detail: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const annee = today().slice(0, 4);
      const du = args.du ?? `${annee}-01-01`;
      const au = args.au ?? `${annee}-12-31`;
      const liste = await client.list("actions_de_formation.php", {
        started_after: du,
        started_before: `${au} 23:59:59`,
        type: args.type,
        fields: "id_action_de_formation",
      });
      const ids = liste.map((s) => String(s.id_action_de_formation));
      const sessions: Row[] = [];
      const financements: Row[] = [];
      const creneaux: Row[] = [];
      for (const l of lots(ids)) {
        sessions.push(...(await client.list("actions_de_formation.php", { id: l.join(","), fields: "id_action_de_formation,numero_complet,intitule,type,date_debut,id_etape_process,nb_participants_inscrits" })));
        financements.push(...(await client.list("financements.php", { id_action_de_formation: l.join(",") })));
        for (const id of l) creneaux.push(...(await client.list("creneaux.php", { id_action_de_formation: id })));
      }
      const etapes = new Map((await client.list("etapes.php")).map((e) => [String(e.id_etape_process), String(e.intitule)]));
      const finParAdf = new Map<string, { finance: number; facture: number; paye: number }>();
      for (const f of financements) {
        const k = String(f.id_action_de_formation);
        const a = finParAdf.get(k) ?? { finance: 0, facture: 0, paye: 0 };
        a.finance += num(f.montant_total_finance);
        a.facture += num(f.montant_total_facture);
        a.paye += num(f.montant_total_paye);
        finParAdf.set(k, a);
      }
      const heuresParAdf = new Map<string, number>();
      for (const c of creneaux) heuresParAdf.set(String(c.id_action_de_formation), (heuresParAdf.get(String(c.id_action_de_formation)) ?? 0) + heuresCreneau(c));

      const groupes = new Map<string, { etape: string; type: string; sessions: number; inscrits: number; heures: number; finance: number; facture: number; paye: number }>();
      const lignes = sessions.map((s) => {
        const id = String(s.id_action_de_formation);
        const fin = finParAdf.get(id) ?? { finance: 0, facture: 0, paye: 0 };
        const etape = etapes.get(String(s.id_etape_process)) ?? "Sans étape";
        const heures = arrondi(heuresParAdf.get(id) ?? 0);
        const cle = `${etape}|${s.type}`;
        const g = groupes.get(cle) ?? { etape, type: String(s.type), sessions: 0, inscrits: 0, heures: 0, finance: 0, facture: 0, paye: 0 };
        g.sessions++;
        g.inscrits += num(s.nb_participants_inscrits);
        g.heures += heures;
        g.finance += fin.finance;
        g.facture += fin.facture;
        g.paye += fin.paye;
        groupes.set(cle, g);
        return { numero: s.numero_complet, intitule: s.intitule, type: s.type, debut: s.date_debut, etape, inscrits: num(s.nb_participants_inscrits), heures, ...fin };
      });
      const total = (k: "finance" | "facture" | "paye") => arrondi([...groupes.values()].reduce((a, g) => a + g[k], 0));
      return json({
        periode: `${du} → ${au}`,
        nb_sessions: sessions.length,
        total_finance: total("finance"),
        total_facture: total("facture"),
        total_paye: total("paye"),
        par_etape: [...groupes.values()].map((g) => ({ ...g, heures: arrondi(g.heures), finance: arrondi(g.finance), facture: arrondi(g.facture), paye: arrondi(g.paye) })),
        note: "La marge n'est pas exposée par l'API : utiliser l'export `facture-avec-marge` via telecharger_export.",
        ...(args.detail ? { sessions: lignes } : {}),
      });
    },
  );
}
