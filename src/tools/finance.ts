import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Query, Row } from "../dendreo/client.js";
import { appliquer, champs } from "./ecriture.js";
import { fichierResultat } from "./exports.js";
import { findEntreprise, findSession, single } from "./resolve.js";
import { LIMITE, addDays, arrondi, borner, compact, dateRenseignee, json, normalize, num, today } from "./util.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SESSION = z.string().describe("Id de l'action de formation ou numéro complet (ADF_…)");

const FORMATS_COMPTA = [
  "ebp", "ebp_v2", "ebp_v3", "ebp_aux", "ebp_aux_txt", "generique", "generique_txt", "sage_pnm", "sage_50", "sage_x3",
  "cegid", "cegid_txt_ana", "cegid_csv_ana", "quadra", "quadra_analytics", "winbiz", "winfic", "louty", "cador_dorac",
] as const;

const MOYENS = ["virement", "cheque", "prelevement", "cb", "paypal", "especes", "stripe", "carte_cadeau", "autre", "cheque_ancv", "paiement_plusieurs_fois"] as const;

const restantDu = (f: Row) => arrondi(num(f.montant_total_ttc) - num(f.montant_paiements));

export function resumeFacture(f: Row, avecLien = false) {
  return compact({
    id_facture: f.id_facture,
    numero: f.numero_complet,
    emission: String(f.date_emission).slice(0, 10),
    echeance: dateRenseignee(f.date_echeance) ? String(f.date_echeance).slice(0, 10) : undefined,
    client: f.raison_sociale,
    id_entreprise: String(f.id_entreprise) !== "0" ? f.id_entreprise : undefined,
    id_financeur: String(f.id_opca) !== "0" ? f.id_opca : undefined,
    total_ht: num(f.montant_total_ht),
    total_ttc: num(f.montant_total_ttc),
    paye: num(f.montant_paiements),
    restant_du: restantDu(f),
    statut: f.statut_facturation,
    niveau_relance: String(f.id_niveau_relance) !== "0" ? f.id_niveau_relance : undefined,
    lien_pdf: avecLien ? f.public_url || undefined : undefined,
  });
}

async function findFinanceur(client: DendreoClient, financeur: string): Promise<Row[]> {
  if (/^\d+$/.test(financeur)) return client.list("financeurs.php", { id: financeur });
  const rows = await client.list("financeurs.php", { raison_sociale: financeur });
  const exact = rows.filter((r) => normalize(r.raison_sociale) === normalize(financeur));
  return exact.length ? exact : rows;
}

export function registerFinanceTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "factures",
    {
      title: "Factures émises",
      description:
        "Factures par session, entreprise, financeur ou période d'émission : montants, payé, restant dû, échéance, statut, " +
        "niveau de relance et lien PDF. `detail=true` ajoute les financements et règlements de chaque facture.",
      inputSchema: {
        session: SESSION.optional(),
        entreprise: z.string().optional().describe("Raison sociale, ENT_… ou id"),
        financeur: z.string().optional().describe("Raison sociale ou id du financeur (OPCO…)"),
        numero: z.string().optional().describe("Numéro complet, ex. FA_2600001"),
        emission_apres: DATE.optional(),
        emission_avant: DATE.optional(),
        impayees_seulement: z.boolean().default(false),
        detail: z.boolean().default(false),
        liens: z.boolean().default(false).describe("Inclure le lien PDF public"),
        limite: LIMITE,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const query: Query = { numero_complet: args.numero, emission_after: args.emission_apres, emission_before: args.emission_avant };
      if (args.detail) query.include = "financements,reglements";
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        query.id_action_de_formation = String(s.row.id_action_de_formation);
      }
      if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        query.id_entreprise = String(e.row.id_entreprise);
      }
      if (args.financeur) {
        const f = single(await findFinanceur(client, args.financeur), "Financeur");
        if (!("row" in f)) return json(f);
        query.id_opca = String(f.row.id_opca);
      }
      let rows = await client.list("factures.php", query);
      if (args.impayees_seulement) rows = rows.filter((f) => restantDu(f) > 0.005);
      const toutes = rows.map((f) => ({
        ...resumeFacture(f, args.liens),
        ...(args.detail ? { financements: f.financements, reglements: f.reglements } : {}),
      }));
      const { items: factures, ...reste } = borner(toutes, args.limite);
      return json({
        nombre: toutes.length,
        total_ttc: arrondi(toutes.reduce((a, f) => a + (f.total_ttc ?? 0), 0)),
        restant_du: arrondi(toutes.reduce((a, f) => a + (f.restant_du ?? 0), 0)),
        ...(reste.avertissement ? { avertissement: reste.avertissement } : {}),
        factures,
      });
    },
  );

  server.registerTool(
    "impayes",
    {
      title: "Factures impayées",
      description:
        "Factures échues non soldées (échéance dépassée et restant dû > 0), groupées par client ou financeur, avec le " +
        "retard en jours et le niveau de relance déjà atteint.",
      inputSchema: {
        depuis: DATE.optional().describe("Factures émises à partir de cette date (défaut : 12 mois avant aujourd'hui)"),
        retard_min_jours: z.number().int().min(0).default(0).describe("Ne garder que les factures échues depuis au moins N jours"),
        limite: LIMITE.describe("Nb max de clients/financeurs détaillés (défaut 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const jour = today();
      const rows = await client.list("factures.php", { emission_after: args.depuis ?? addDays(jour, -365) });
      const groupes = new Map<string, { client: string; type: string; total: number; factures: unknown[] }>();
      for (const f of rows) {
        const restant = restantDu(f);
        if (restant <= 0.005 || !dateRenseignee(f.date_echeance)) continue;
        const retard = Math.round((Date.parse(jour) - Date.parse(String(f.date_echeance).slice(0, 10))) / 86400000);
        if (retard <= 0 || retard < args.retard_min_jours) continue;
        const financeur = String(f.id_opca) !== "0";
        const cle = `${financeur ? "financeur" : "client"}:${financeur ? f.id_opca : f.id_entreprise}:${f.raison_sociale}`;
        const g = groupes.get(cle) ?? { client: String(f.raison_sociale), type: financeur ? "financeur" : "client", total: 0, factures: [] };
        g.total = arrondi(g.total + restant);
        g.factures.push({ ...resumeFacture(f), retard_jours: retard });
        groupes.set(cle, g);
      }
      const liste = [...groupes.values()].sort((a, b) => b.total - a.total);
      const { items: clients, avertissement } = borner(liste, args.limite);
      return json({ total_impaye: arrondi(liste.reduce((a, g) => a + g.total, 0)), nb_clients: liste.length, ...(avertissement ? { avertissement } : {}), clients });
    },
  );

  server.registerTool(
    "reglements",
    {
      title: "Règlements",
      description:
        "Liste les règlements (par facture ou période), ou en saisit, modifie ou supprime un. Seuls les règlements non exportés en " +
        "comptabilité sont modifiables ou supprimables. Écritures en dry_run=true par défaut : ne relancer avec dry_run=false " +
        "qu'après confirmation explicite.",
      inputSchema: {
        action: z.enum(["lister", "creer", "modifier", "supprimer"]).default("lister"),
        facture: z.string().optional().describe("Numéro complet (FA_…) ou id de facture"),
        du: DATE.optional(),
        au: DATE.optional(),
        id_reglement: z.string().optional().describe("Requis pour modifier ou supprimer"),
        montant: z.number().optional().describe("Requis pour créer ou modifier (non nul)"),
        date: DATE.optional(),
        moyen: z.enum(MOYENS).optional(),
        reference: z.string().optional(),
        commentaire: z.string().optional(),
        num_dossier_cpf: z.string().optional().describe("Rattache automatiquement le règlement à l'OPCO CPF"),
        limite: LIMITE,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      let idFacture: string | undefined;
      if (args.facture) {
        const rows = /^\d+$/.test(args.facture)
          ? await client.list("factures.php", { id: args.facture })
          : await client.list("factures.php", { numero_complet: args.facture });
        const f = single(rows, "Facture");
        if (!("row" in f)) return json(f);
        idFacture = String(f.row.id_facture);
      }
      if (args.action === "lister") {
        const rows = await client.list("reglements.php", { facture_id: idFacture, date_after: args.du, date_before: args.au });
        const tous = rows.map((r) => ({
          id: r.id, facture: r.facture_id, date: String(r.date).slice(0, 10), montant: num(r.amount), moyen: r.method || undefined,
          reference: r.reference || undefined, exporte: dateRenseignee(r.exported_at),
        }));
        const { items: reglements, avertissement } = borner(tous, args.limite);
        return json({ nombre: tous.length, total: arrondi(tous.reduce((a, r) => a + r.montant, 0)), ...(avertissement ? { avertissement } : {}), reglements });
      }
      if (args.action === "supprimer") {
        if (!args.id_reglement) return json({ erreur: "id_reglement requis." });
        const [r] = await client.list("reglements.php", { id: args.id_reglement });
        if (!r) return json({ erreur: "Règlement introuvable." });
        if (dateRenseignee(r.exported_at)) return json({ erreur: "Règlement déjà exporté en comptabilité : suppression impossible.", reglement: { id: r.id, facture: r.facture_id, montant: r.amount, date: r.date } });
        return appliquer(args.dry_run, { action: "suppression", reglement: { id: r.id, facture: r.facture_id, montant: r.amount, date: r.date } }, () =>
          client.delete("reglements.php", { id: args.id_reglement! }),
        );
      }
      if (args.montant === undefined || args.montant === 0) return json({ erreur: "montant requis (non nul)." });
      const body = champs({
        id: args.action === "modifier" ? args.id_reglement : undefined,
        facture_id: idFacture, date: args.date, amount: args.montant, method: args.moyen,
        reference: args.reference, comment: args.commentaire, num_dossier_cpf: args.num_dossier_cpf,
      });
      if (args.action === "modifier") {
        if (!args.id_reglement) return json({ erreur: "id_reglement requis pour modifier." });
        const [r] = await client.list("reglements.php", { id: args.id_reglement });
        if (!r) return json({ erreur: "Règlement introuvable." });
        if (dateRenseignee(r.exported_at)) return json({ erreur: "Règlement déjà exporté en comptabilité : modification impossible." });
        return appliquer(args.dry_run, { action: "modification", avant: { montant: r.amount, date: r.date, moyen: r.method, reference: r.reference, commentaire: r.comment }, valeurs: body }, () => client.post("reglements.php", body));
      }
      return appliquer(args.dry_run, { action: "creation", valeurs: body }, () => client.post("reglements.php", body));
    },
  );

  server.registerTool(
    "financements",
    {
      title: "Financements d'une session",
      description:
        "Qui finance quoi : financements d'une session, d'une entreprise ou d'un financeur (OPCO, entreprise, CPF), avec " +
        "montants financé / facturé / payé et participants concernés. Peut supprimer un financement (dry_run=true par défaut) ; " +
        "la création et la modification ne sont pas possibles via l'API.",
      inputSchema: {
        session: SESSION.optional(),
        entreprise: z.string().optional(),
        financeur: z.string().optional().describe("Raison sociale ou id d'un financeur externe"),
        supprimer: z.string().optional().describe("id_financement à supprimer"),
        limite: LIMITE,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.supprimer) {
        const [f] = await client.list("financements.php", { id: args.supprimer });
        if (!f) return json({ erreur: "Financement introuvable." });
        return appliquer(args.dry_run, { action: "suppression", financement: { id: f.id_financement, id_action_de_formation: f.id_action_de_formation, type: f.type, montant_total_finance: f.montant_total_finance } }, () => client.delete("financements.php", { id_financement: args.supprimer! }));
      }
      const query: Query = { include: "lfps,financeur,entreprise" };
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        query.id_action_de_formation = String(s.row.id_action_de_formation);
      }
      if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        query.id_entreprise = String(e.row.id_entreprise);
      }
      if (args.financeur) {
        const f = single(await findFinanceur(client, args.financeur), "Financeur");
        if (!("row" in f)) return json(f);
        query.id_financeur = String(f.row.id_opca);
        query.type = "financeur_externe";
      }
      if (!query.id_action_de_formation && !query.id_entreprise && !query.id_financeur) {
        return json({ erreur: "Préciser une session, une entreprise ou un financeur." });
      }
      const rows = await client.list("financements.php", query);
      const tous = rows.map((f) => ({
        id_financement: f.id_financement,
        id_action_de_formation: f.id_action_de_formation,
        type: f.type,
        financeur: (f.financeur as Row | undefined)?.raison_sociale ?? (f.entreprise as Row | undefined)?.raison_sociale,
        numero_dossier: f.numero_dossier || undefined,
        finance: num(f.montant_total_finance),
        facture: num(f.montant_total_facture),
        paye: num(f.montant_total_paye),
        participants: ((f.lfps ?? []) as Row[]).map((l) => {
          const p = (l.participant ?? (l.lap as Row | undefined)?.participant ?? {}) as Row;
          return [p.prenom, p.nom].filter(Boolean).join(" ") || `lap ${l.id_lap}`;
        }),
      }));
      const { items: financements, avertissement } = borner(tous, args.limite);
      return json({
        nombre: tous.length,
        finance: arrondi(tous.reduce((a, f) => a + f.finance, 0)),
        facture: arrondi(tous.reduce((a, f) => a + f.facture, 0)),
        paye: arrondi(tous.reduce((a, f) => a + f.paye, 0)),
        ...(avertissement ? { avertissement } : {}),
        financements,
      });
    },
  );

  server.registerTool(
    "financeurs",
    {
      title: "Financeurs externes",
      description: "Recherche un financeur (OPCO, financeur public) et renvoie sa fiche, ses factures et ses contacts rattachés.",
      inputSchema: { financeur: z.string().optional().describe("Raison sociale ou id ; vide = liste de tous les financeurs") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (!args.financeur) {
        const rows = await client.list("financeurs.php");
        return json({ nombre: rows.length, financeurs: rows.map((r) => ({ id_opca: r.id_opca, raison_sociale: r.raison_sociale, ville: r.ville })) });
      }
      const f = single(await findFinanceur(client, args.financeur), "Financeur");
      if (!("row" in f)) return json(f);
      const id = String(f.row.id_opca);
      const [factures, contacts] = await Promise.all([
        client.list("factures.php", { id_opca: id }),
        client.list("contacts.php", { id_opca: id, fields: "id_contact,prenom,nom,email,fonction" }),
      ]);
      return json({ financeur: compact({ id_opca: f.row.id_opca, raison_sociale: f.row.raison_sociale, ville: f.row.ville, email: f.row.email, telephone: f.row.telephone }), factures: factures.slice(0, 50).map((x) => resumeFacture(x)), nb_factures: factures.length, restant_du: arrondi(factures.reduce((a, x) => a + restantDu(x), 0)), contacts });
    },
  );

  server.registerTool(
    "bilan_financier_session",
    {
      title: "Bilan financier d'une session",
      description:
        "CA prévu (prix des inscriptions) comparé au financé, au facturé et à l'encaissé pour une session, avec les écarts " +
        "(reste à facturer, reste à encaisser) et l'alerte « session non facturée ».",
      inputSchema: { session: SESSION },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule,date_fin"), "Session");
      if (!("row" in s)) return json(s);
      const id = String(s.row.id_action_de_formation);
      const [laps, financements, factures] = await Promise.all([
        client.list("laps.php", { id_action_de_formation: id }),
        client.list("financements.php", { id_action_de_formation: id }),
        client.list("factures.php", { id_action_de_formation: id }),
      ]);
      const prevu = laps.reduce((a, l) => a + num(l.prix), 0);
      const finance = financements.reduce((a, f) => a + num(f.montant_total_finance), 0);
      const facture = financements.reduce((a, f) => a + num(f.montant_total_facture), 0);
      const paye = factures.reduce((a, f) => a + num(f.montant_paiements), 0);
      const alertes: string[] = [];
      if (factures.length === 0 && prevu > 0) alertes.push("Aucune facture émise pour cette session.");
      if (financements.length === 0 && laps.length > 0) alertes.push("Aucun financement saisi alors que des participants sont inscrits.");
      if (prevu > 0 && facture + 0.005 < prevu) alertes.push(`Reste à facturer : ${arrondi(prevu - facture)} €.`);
      return json({
        session: `${s.row.numero_complet} — ${s.row.intitule}`,
        nb_inscrits: laps.length,
        ca_prevu: arrondi(prevu),
        finance: arrondi(finance),
        facture: arrondi(facture),
        encaisse: arrondi(paye),
        reste_a_facturer: arrondi(prevu - facture),
        reste_a_encaisser: arrondi(factures.reduce((a, f) => a + restantDu(f), 0)),
        factures: factures.map((x) => resumeFacture(x)),
        ...(alertes.length ? { alertes } : {}),
      });
    },
  );

  server.registerTool(
    "export_comptable",
    {
      title: "Export comptable des ventes",
      description:
        "Génère le fichier d'export comptable du journal des ventes (Sage, EBP, Cegid, Quadra…) pour une liste de factures " +
        "(numéros FA_… ou ids) ou un lot, et renvoie le fichier.",
      inputSchema: {
        format: z.enum(FORMATS_COMPTA).describe("Format du logiciel comptable"),
        factures: z.array(z.string()).optional().describe("Numéros FA_… ou ids de factures"),
        id_lot: z.string().optional(),
        numero_lot: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const query: Query = { format_export: args.format, journal: "ventes" };
      if (args.factures?.length) {
        const ids: string[] = [];
        for (const f of args.factures) {
          if (/^\d+$/.test(f)) ids.push(f);
          else {
            const r = single(await client.list("factures.php", { numero_complet: f }), `Facture ${f}`);
            if (!("row" in r)) return json(r);
            ids.push(String(r.row.id_facture));
          }
        }
        query.factures = ids.join(",");
      } else if (args.id_lot) query.id_lot = args.id_lot;
      else if (args.numero_lot) query.numero_lot = args.numero_lot;
      else return json({ erreur: "Préciser des factures, un id_lot ou un numero_lot." });
      const doc = await client.download("export_comptable.php", query);
      return fichierResultat(doc, doc.nom ?? `export_comptable_${args.format}.txt`, { format: args.format });
    },
  );
}
