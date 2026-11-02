import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { appliquer } from "./ecriture.js";
import { findEntreprise, findSession, inscriptionsSession, single } from "./resolve.js";
import { CHAMPS_PERSONNALISES, json, nomDe, normalize, num, today, vrai } from "./util.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ENTREPRISE = z.string().describe("Raison sociale, numéro ENT_… ou id");

/** Garde les champs renseignés, sous leur nom Dendreo. */
function champs(map: Record<string, unknown>): Row {
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
}

/** Résultat commun des outils de création / mise à jour de fiche CRM. */
async function enregistrer(
  client: DendreoClient,
  endpoint: string,
  cleId: string,
  existant: Row | undefined,
  body: Row,
  dryRun: boolean,
  libelle: string,
) {
  const action = existant ? "mise_a_jour" : "creation";
  const recap = {
    action,
    fiche: libelle,
    ...(existant ? { [cleId]: existant[cleId], avant: Object.fromEntries(Object.keys(body).map((k) => [k, existant[k]])) } : {}),
    valeurs: body,
  };
  if (dryRun) return json({ dry_run: true, ...recap });
  const resultat = (await client.post(endpoint, existant ? { [cleId]: existant[cleId], ...body } : body)) as Row;
  return json({ ok: true, ...recap, [cleId]: resultat?.[cleId] ?? existant?.[cleId] });
}

export function registerCrmTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "fiche_entreprise",
    {
      title: "Fiche complète d'une entreprise",
      description:
        "Vue d'ensemble d'une entreprise cliente : coordonnées, chiffre d'affaires, contacts, salariés participants, " +
        "formations passées et à venir, dernières actions commerciales et opportunités en cours.",
      inputSchema: { entreprise: ENTREPRISE },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
      if (!("row" in r)) return json(r);
      const id = String(r.row.id_entreprise);
      const [[ent], contacts, participants, laps, actions, opportunites] = await Promise.all([
        client.list("entreprises.php", { id, include: "stats" }),
        client.list("contacts.php", { id_entreprise: id }),
        client.list("participants.php", { id_entreprise: id, fields: "id_participant,prenom,nom,email,fonction" }),
        client.list("laps.php", { id_entreprise: id }),
        client.list("actions_commerciales.php", { id_entreprise: id }),
        client.list("opportunites.php", { id_entreprise: id }),
      ]);
      const adfIds = [...new Set(laps.map((l) => String(l.id_action_de_formation ?? "")))].filter((id) => /^\d+$/.test(id));
      const adfs = adfIds.length
        ? await client.list("actions_de_formation.php", {
            id: adfIds.join(","),
            fields: "id_action_de_formation,numero_complet,intitule,date_debut,date_fin",
          })
        : [];
      const inscritsParAdf = new Map<string, number>();
      for (const l of laps) inscritsParAdf.set(String(l.id_action_de_formation), (inscritsParAdf.get(String(l.id_action_de_formation)) ?? 0) + 1);
      const formation = (a: Row) => ({
        session: `${a.numero_complet} — ${a.intitule}`,
        du: String(a.date_debut).slice(0, 10),
        au: String(a.date_fin).slice(0, 10),
        participants: inscritsParAdf.get(String(a.id_action_de_formation)),
      });
      const tri = [...adfs].sort((a, b) => String(b.date_debut).localeCompare(String(a.date_debut)));
      const e = ent ?? r.row;
      return json({
        entreprise: {
          id,
          raison_sociale: e.raison_sociale,
          numero: e.numero_complet,
          siret: e.siret || undefined,
          adresse: [e.adresse, e.code_postal, e.ville].filter(Boolean).join(" ") || undefined,
          telephone: e.telephone || undefined,
          email: e.email_standard || undefined,
          client: e.client,
          fournisseur: e.fournisseur,
          ca_facture: e.ca_facture,
          commentaires: e.commentaires || undefined,
        },
        contacts: contacts.map((c) => ({
          id_contact: c.id_contact,
          nom: nomDe(c),
          fonction: c.fonction || undefined,
          email: c.email || undefined,
          telephone: c.telephone_direct || c.portable || undefined,
          principal: String(c.contact_principal) === "1" || undefined,
        })),
        participants: participants.map((p) => ({ id_participant: p.id_participant, nom: nomDe(p), email: p.email || undefined })),
        formations_a_venir: tri.filter((a) => String(a.date_fin).slice(0, 10) >= today()).reverse().map(formation),
        formations_passees: tri.filter((a) => String(a.date_fin).slice(0, 10) < today()).slice(0, 20).map(formation),
        actions_commerciales: actions
          .filter((a) => String(a.id_entreprise ?? id) === id)
          .slice(0, 10)
          .map((a) => ({
            date: String(a.date_action).slice(0, 10),
            compte_rendu: a.compte_rendu,
            relance: a.date_relance ? String(a.date_relance).slice(0, 10) : undefined,
            commerciaux: ((a.commerciaux ?? []) as Row[]).map((c) => c.nom_complet),
          })),
        opportunites: opportunites
          .filter((o) => String(o.entreprise_id) === id && !o.closed_at && !o.lost_at)
          .map((o) => ({ numero: o.numero_complet, description: o.description || undefined, etape: o.opportunite_etape_id })),
      });
    },
  );

  server.registerTool(
    "enregistrer_entreprise",
    {
      title: "Créer ou mettre à jour une entreprise",
      description:
        "Crée une entreprise dans le CRM, ou met à jour la fiche existante. La fiche existante est retrouvée par " +
        "`entreprise` (raison sociale, ENT_… ou id) ou par SIRET, pour éviter les doublons.",
      inputSchema: {
        entreprise: z.string().optional().describe("Fiche à mettre à jour (sinon création)"),
        raison_sociale: z.string().optional().describe("Obligatoire en création"),
        siret: z.string().optional(),
        adresse: z.string().optional(),
        code_postal: z.string().optional(),
        ville: z.string().optional(),
        pays: z.string().optional(),
        telephone: z.string().optional(),
        email_standard: z.string().optional(),
        site_internet: z.string().optional(),
        code_naf: z.string().optional(),
        nb_employes: z.number().int().optional(),
        client: z.boolean().optional(),
        fournisseur: z.boolean().optional().describe("Fournisseur / sous-traitant"),
        id_administrateur: z.number().int().optional().describe("Commercial associé"),
        entreprise_parente: z.string().optional().describe("Raison sociale de l'entreprise mère (groupe)"),
        commentaires: z.string().optional(),
        champs_personnalises: CHAMPS_PERSONNALISES,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let existant: Row | undefined;
      if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        [existant] = await client.list("entreprises.php", { id: String(r.row.id_entreprise) });
      } else {
        const doublons = [
          ...(args.siret ? await client.list("entreprises.php", { siret: args.siret.replace(/\s/g, "") }) : []),
          ...(args.raison_sociale
            ? (await client.list("entreprises.php", { search: args.raison_sociale, fields: "id_entreprise,raison_sociale,numero_complet,siret,ville" }))
                .filter((e) => normalize(e.raison_sociale) === normalize(args.raison_sociale))
            : []),
        ];
        if (doublons.length) {
          return json({
            erreur: "Une entreprise semblable existe déjà : passer `entreprise` pour la mettre à jour.",
            existantes: doublons.map((e) => ({ id_entreprise: e.id_entreprise, raison_sociale: e.raison_sociale, siret: e.siret, ville: e.ville })),
          });
        }
        if (!args.raison_sociale) return json({ erreur: "La raison sociale est obligatoire en création." });
      }
      const body = champs({
        raison_sociale: args.raison_sociale ?? existant?.raison_sociale,
        siret: args.siret?.replace(/\s/g, ""),
        adresse: args.adresse,
        code_postal: args.code_postal,
        ville: args.ville,
        pays: args.pays,
        telephone: args.telephone,
        email_standard: args.email_standard,
        site_internet: args.site_internet,
        code_naf: args.code_naf,
        nb_employes: args.nb_employes,
        client: args.client === undefined ? undefined : args.client ? 1 : 0,
        fournisseur: args.fournisseur === undefined ? undefined : args.fournisseur ? 1 : 0,
        id_administrateur: args.id_administrateur,
        entreprise_parente: args.entreprise_parente,
        commentaires: args.commentaires,
        ...args.champs_personnalises,
      });
      return enregistrer(client, "entreprises.php", "id_entreprise", existant, body, args.dry_run, String(body.raison_sociale));
    },
  );

  server.registerTool(
    "enregistrer_contact",
    {
      title: "Créer ou mettre à jour un contact d'entreprise",
      description:
        "Crée un contact (interlocuteur RH, formation, achats…) dans une entreprise, ou met à jour un contact existant " +
        "retrouvé par son id ou son email. Peut le définir comme contact principal, secondaire ou de facturation. " +
        "Par défaut dry_run=true : rien n'est écrit.",
      inputSchema: {
        entreprise: ENTREPRISE.optional().describe("Entreprise du contact (obligatoire en création)"),
        id_contact: z.string().optional().describe("Contact à mettre à jour"),
        nom: z.string().optional(),
        prenom: z.string().optional(),
        civilite: z.string().optional().describe("M. ou Mme."),
        fonction: z.string().optional(),
        email: z.string().email().optional(),
        telephone_direct: z.string().optional(),
        portable: z.string().optional(),
        role: z.enum(["principal", "secondaire", "facturation"]).optional(),
        champs_personnalises: CHAMPS_PERSONNALISES,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let idEntreprise: unknown;
      if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        idEntreprise = r.row.id_entreprise;
      }
      let existant: Row | undefined;
      if (args.id_contact) {
        [existant] = await client.list("contacts.php", { id: args.id_contact });
        if (!existant) return json({ erreur: "Contact introuvable." });
      } else if (args.email) {
        const found = await client.list("contacts.php", { email: args.email });
        existant = found.find((c) => !idEntreprise || String(c.id_entreprise) === String(idEntreprise));
      }
      if (!existant && (!idEntreprise || !args.nom)) return json({ erreur: "En création, l'entreprise et le nom sont obligatoires." });
      const body = champs({
        ...(existant ? {} : { id_entreprise: idEntreprise }),
        nom: args.nom ?? existant?.nom,
        prenom: args.prenom,
        civilite: args.civilite,
        fonction: args.fonction,
        email: args.email,
        telephone_direct: args.telephone_direct,
        portable: args.portable,
        ...(args.role ? { [`contact_${args.role}`]: 1 } : {}),
        ...args.champs_personnalises,
      });
      return enregistrer(client, "contacts.php", "id_contact", existant, body, args.dry_run, `${args.prenom ?? existant?.prenom ?? ""} ${body.nom}`.trim());
    },
  );

  server.registerTool(
    "enregistrer_participant",
    {
      title: "Créer ou mettre à jour un participant",
      description:
        "Crée un participant (stagiaire) dans le CRM ou met à jour sa fiche, retrouvée par id ou email (un seul " +
        "email par participant dans Dendreo). Par défaut dry_run=true : rien n'est écrit.",
      inputSchema: {
        id_participant: z.string().optional().describe("Participant à mettre à jour"),
        email: z.string().email().optional(),
        nom: z.string().optional(),
        prenom: z.string().optional(),
        civilite: z.string().optional(),
        entreprise: ENTREPRISE.optional(),
        fonction: z.string().optional(),
        portable: z.string().optional(),
        date_de_naissance: DATE.optional(),
        statut_bpf: z.enum(["salarie", "agent_public", "non_salarie", "benevole", "autre"]).optional(),
        niveau_diplome: z.enum(["sans", "cqp", "cap-bep", "bac", "bac+2", "bac+3", "bac+5", "bac+8"]).optional(),
        commentaires: z.string().optional(),
        champs_personnalises: CHAMPS_PERSONNALISES,
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let idEntreprise: unknown;
      if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        idEntreprise = r.row.id_entreprise;
      }
      let existant: Row | undefined;
      if (args.id_participant) {
        [existant] = await client.list("participants.php", { id: args.id_participant });
        if (!existant) return json({ erreur: "Participant introuvable." });
      } else if (args.email) {
        const found = await client.list("participants.php", { email: args.email });
        if (found.length > 1) return json({ erreur: "Plusieurs fiches avec cet email : préciser id_participant.", fiches: found.map((p) => ({ id: p.id_participant, nom: nomDe(p) })) });
        existant = found[0];
      }
      if (!existant && (!args.nom || !args.prenom)) return json({ erreur: "En création, le nom et le prénom sont obligatoires." });
      const body = champs({
        nom: args.nom ?? existant?.nom,
        prenom: args.prenom ?? existant?.prenom,
        email: args.email,
        civilite: args.civilite,
        id_entreprise: idEntreprise,
        fonction: args.fonction,
        portable: args.portable,
        date_de_naissance: args.date_de_naissance,
        statut_bpf: args.statut_bpf,
        niveau_diplome: args.niveau_diplome,
        commentaires: args.commentaires,
        ...args.champs_personnalises,
      });
      const avertissement =
        existant && idEntreprise && String(existant.id_entreprise) !== String(idEntreprise)
          ? "Changement d'entreprise : les inscriptions passées gardent l'entreprise d'origine."
          : undefined;
      const res = await enregistrer(client, "participants.php", "id_participant", existant, body, args.dry_run, `${body.prenom} ${body.nom}`);
      if (avertissement && res.content[0]?.type === "text") {
        res.content[0].text = JSON.stringify({ avertissement, ...JSON.parse(res.content[0].text) });
      }
      return res;
    },
  );

  server.registerTool(
    "convertir_en_particulier",
    {
      title: "Convertir en particulier",
      description:
        "Convertit un participant (ou une entreprise) en particulier, par exemple pour une formation financée en CPF. " +
        "Conditions Dendreo : le participant est seul dans son entreprise et celle-ci a au plus un contact ; une " +
        "entreprise convertie a au plus un contact et un participant. Par défaut dry_run=true.",
      inputSchema: {
        id_participant: z.string().optional(),
        entreprise: ENTREPRISE.optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let idEntreprise: string | undefined;
      const bloquants: string[] = [];
      let fiche: string | undefined;
      if (args.id_participant) {
        const [p] = await client.list("participants.php", { id: args.id_participant });
        if (!p) return json({ erreur: "Participant introuvable." });
        fiche = nomDe(p);
        idEntreprise = p.id_entreprise && String(p.id_entreprise) !== "0" ? String(p.id_entreprise) : undefined;
      } else if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        idEntreprise = String(r.row.id_entreprise);
        fiche = String(r.row.raison_sociale);
      } else {
        return json({ erreur: "Préciser id_participant ou entreprise." });
      }
      if (idEntreprise) {
        const [contacts, participants] = await Promise.all([
          client.list("contacts.php", { id_entreprise: idEntreprise, fields: "id_contact" }),
          client.list("participants.php", { id_entreprise: idEntreprise, fields: "id_participant" }),
        ]);
        if (contacts.length > 1) bloquants.push(`L'entreprise a ${contacts.length} contacts (1 maximum).`);
        if (participants.length > 1) bloquants.push(`L'entreprise a ${participants.length} participants (1 maximum).`);
      }
      const body = args.id_participant ? { id_participant: args.id_participant } : { id_entreprise: idEntreprise };
      const recap = { fiche, ...(bloquants.length ? { bloquants } : {}) };
      if (args.dry_run || bloquants.length) return json({ dry_run: args.dry_run, ...recap });
      return json({ ok: true, ...recap, resultat: await client.post("convert_particulier.php", body) });
    },
  );

  server.registerTool(
    "actions_commerciales",
    {
      title: "Actions commerciales",
      description:
        "Journal commercial : `lister` les échanges d'une entreprise ou d'un commercial, ou les relances à venir ; " +
        "`ajouter` un compte rendu d'échange avec une date de relance. Ajout en dry_run=true par défaut.",
      inputSchema: {
        action: z.enum(["lister", "ajouter"]).default("lister"),
        entreprise: ENTREPRISE.optional(),
        commercial_id: z.string().optional().describe("Id de l'administrateur commercial (voir dendreo_get administrateurs.php)"),
        relances_a_venir: z.boolean().optional().describe("Lister uniquement les actions avec une relance à venir"),
        id_contact: z.string().optional(),
        id_participant: z.string().optional(),
        compte_rendu: z.string().optional(),
        date_action: DATE.optional().describe("Défaut : aujourd'hui"),
        date_relance: DATE.optional(),
        priorite: z.number().int().min(0).max(2).optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let entreprise: Row | undefined;
      if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        entreprise = r.row;
      }
      if (args.action === "lister") {
        const rows = await client.list("actions_commerciales.php", {
          id_entreprise: entreprise ? String(entreprise.id_entreprise) : undefined,
          commercial_id: args.commercial_id,
          relance: args.relances_a_venir ? 1 : undefined,
        });
        return json({
          nombre: rows.length,
          actions: rows.map((a) => ({
            id: a.id_action_commerciale,
            date: String(a.date_action).slice(0, 10),
            relance: a.date_relance ? String(a.date_relance).slice(0, 10) : undefined,
            priorite: a.priorite,
            compte_rendu: a.compte_rendu,
            commerciaux: ((a.commerciaux ?? []) as Row[]).map((c) => c.nom_complet),
            interlocuteurs: ((a.interlocuteurs ?? []) as Row[]).map((i) => i.raison_sociale ?? nomDe(i)),
          })),
        });
      }
      if (!args.commercial_id) return json({ erreur: "commercial_id est obligatoire (auteur de l'action)." });
      if (!entreprise && !args.id_contact && !args.id_participant) {
        return json({ erreur: "Rattacher l'action à une entreprise, un contact ou un participant." });
      }
      const body = champs({
        commercial_id: args.commercial_id,
        id_entreprise: entreprise?.id_entreprise,
        id_contact: args.id_contact,
        id_participant: args.id_participant,
        compte_rendu: args.compte_rendu,
        date_action: args.date_action ?? today(),
        date_relance: args.date_relance,
        priorite: args.priorite,
      });
      if (args.dry_run) return json({ dry_run: true, action_commerciale: body });
      return json({ ok: true, resultat: await client.post("actions_commerciales.php", body) });
    },
  );

  server.registerTool(
    "opportunites",
    {
      title: "Opportunités commerciales",
      description:
        "Pipe commercial : `lister` les opportunités ouvertes (par étape ou entreprise) avec leurs devis et les sessions " +
        "issues de ces devis ; `creer` une opportunité pour une entreprise (dry_run=true par défaut).",
      inputSchema: {
        action: z.enum(["lister", "creer"]).default("lister"),
        entreprise: ENTREPRISE.optional(),
        etape: z.string().optional().describe("Étape (intitulé ou id), ex. « Négociation »"),
        inclure_fermees: z.boolean().default(false),
        description: z.string().optional(),
        id_contact: z.string().optional(),
        id_administrateur: z.string().optional().describe("Commercial en charge"),
        source: z.string().optional().describe("Source (intitulé ou id)"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const [etapes, sources] = await Promise.all([client.list("opportunite_etapes.php"), client.list("sources.php")]);
      const trouve = (rows: Row[], q: string) =>
        rows.find((r) => String(r.id) === q || normalize(r.name) === normalize(q));
      const libelleEtape = (id: unknown) => {
        const e = etapes.find((x) => String(x.id) === String(id));
        return e ? `${e.name} (${e.success_chance ?? "?"} %)` : id;
      };
      let entreprise: Row | undefined;
      if (args.entreprise) {
        const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in r)) return json(r);
        entreprise = r.row;
      }
      const etape = args.etape ? trouve(etapes, args.etape) : undefined;
      if (args.etape && !etape) return json({ erreur: "Étape inconnue.", etapes: etapes.map((e) => e.name) });

      if (args.action === "lister") {
        const rows = await client.list("opportunites.php", {
          id_entreprise: entreprise ? String(entreprise.id_entreprise) : undefined,
          opportunite_etape_id: etape ? String(etape.id) : undefined,
          include: "devis,devis_formations",
        });
        const filtrees = rows.filter(
          (o) =>
            (!entreprise || String(o.entreprise_id) === String(entreprise.id_entreprise)) &&
            (!etape || String(o.opportunite_etape_id) === String(etape.id)) &&
            (args.inclure_fermees || (!o.closed_at && !o.lost_at)),
        );
        return json({
          nombre: filtrees.length,
          opportunites: filtrees.map((o) => ({
            id: o.id,
            numero: o.numero_complet,
            etape: libelleEtape(o.opportunite_etape_id),
            id_entreprise: o.entreprise_id,
            description: o.description || undefined,
            creee_le: String(o.created_at).slice(0, 10),
            statut: o.lost_at ? "perdue" : o.closed_at ? "gagnée/fermée" : "ouverte",
            devis: ((o.devis ?? []) as Row[]).map((d) => ({
              numero: d.numero_complet,
              accepte: Boolean(d.accepted_at),
              sessions: ((d.formations ?? []) as Row[]).map((f) => f.id_action_de_formation),
            })),
          })),
        });
      }
      if (!entreprise) return json({ erreur: "L'entreprise est obligatoire pour créer une opportunité." });
      const source = args.source ? trouve(sources, args.source) : undefined;
      const body = champs({
        id_entreprise: entreprise.id_entreprise,
        id_contact: args.id_contact,
        id_administrateur: args.id_administrateur,
        id_etape: etape?.id,
        id_source: source?.id,
        description: args.description,
      });
      if (args.dry_run) return json({ dry_run: true, entreprise: entreprise.raison_sociale, opportunite: body });
      return json({ ok: true, resultat: await client.post("opportunites.php", body) });
    },
  );
}

const LIGNE = z.record(z.union([z.string(), z.number(), z.boolean()]));
const MAX_LIGNES = 200;

export function registerCrmNettoyageTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "enregistrer_particulier",
    {
      title: "Créer ou mettre à jour un particulier",
      description:
        "Crée un particulier (personne finançant elle-même sa formation : fiche contact + entreprise + participant) ou met à jour " +
        "sa fiche, retrouvée par id ou email. Par défaut dry_run=true : rien n'est écrit.",
      inputSchema: {
        id_contact: z.string().optional().describe("Particulier à mettre à jour (id_contact)"),
        email: z.string().email().optional(),
        nom: z.string().optional(),
        prenom: z.string().optional(),
        civilite: z.string().optional(),
        fonction: z.string().optional(),
        telephone_direct: z.string().optional(),
        portable: z.string().optional(),
        adresse: z.string().optional(),
        code_postal: z.string().optional(),
        ville: z.string().optional(),
        statut_bpf: z.enum(["independant", "cpf_autonome", "recherche_emploi", "hors_bpf"]).optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let existant: Row | undefined;
      if (args.id_contact) {
        [existant] = await client.list("contacts.php", { id: args.id_contact });
        if (!existant) return json({ erreur: "Particulier introuvable." });
      } else if (args.email) {
        existant = (await client.list("contacts.php", { email: args.email })).find((c) => vrai(c.particulier));
      }
      if (!existant && (!args.nom || !args.prenom)) return json({ erreur: "En création, le nom et le prénom sont obligatoires." });
      const body = champs({
        nom: args.nom, prenom: args.prenom, civilite: args.civilite, fonction: args.fonction, email: args.email,
        telephone_direct: args.telephone_direct, portable: args.portable, adresse: args.adresse, code_postal: args.code_postal,
        ville: args.ville, statut_bpf: args.statut_bpf,
      });
      const recap = {
        action: existant ? "mise_a_jour" : "creation",
        particulier: `${args.prenom ?? existant?.prenom ?? ""} ${args.nom ?? existant?.nom ?? ""}`.trim(),
        ...(existant ? { id_contact: existant.id_contact, avant: Object.fromEntries(Object.keys(body).map((k) => [k, existant![k]])) } : {}),
        valeurs: body,
      };
      return appliquer(args.dry_run, recap, () =>
        existant ? client.post("particuliers.php", { id_contact: existant.id_contact, ...body }) : client.post("contacts.php", { particulier: 1, ...body }),
      );
    },
  );

  server.registerTool(
    "convertir_particulier_en_entreprise",
    {
      title: "Convertir un particulier en entreprise",
      description:
        "Transforme un particulier en entreprise + contact + participant (par exemple quand un indépendant devient client avec sa " +
        "société). Par défaut dry_run=true. Le sens inverse est `convertir_en_particulier`.",
      inputSchema: {
        id_contact: z.string().optional(),
        email: z.string().email().optional().describe("À la place de id_contact"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      let contact: Row | undefined;
      if (args.id_contact) [contact] = await client.list("contacts.php", { id: args.id_contact });
      else if (args.email) contact = (await client.list("contacts.php", { email: args.email })).find((c) => vrai(c.particulier));
      else return json({ erreur: "Préciser id_contact ou email." });
      if (!contact) return json({ erreur: "Particulier introuvable." });
      if (!vrai(contact.particulier)) return json({ erreur: "Cette fiche n'est pas un particulier.", contact: { id_contact: contact.id_contact, nom: nomDe(contact) } });
      return appliquer(args.dry_run, { particulier: nomDe(contact), id_contact: contact.id_contact }, () =>
        client.post("contacts.php", { id_contact: contact!.id_contact, convert_to_entreprise_contact_participant: 1 }),
      );
    },
  );

  server.registerTool(
    "importer_crm",
    {
      title: "Importer des fiches CRM en masse",
      description:
        `Importe jusqu'à ${MAX_LIGNES} fiches d'un même type (entreprises, contacts, participants, particuliers) depuis une liste. ` +
        "Dédoublonnage : entreprises par SIRET puis raison sociale ; contacts, participants et particuliers par email. " +
        "Une fiche existante est ignorée, ou mise à jour avec `mettre_a_jour=true`. Les champs de chaque ligne portent le nom " +
        "Dendreo (raison_sociale, siret, nom, prenom, email, fonction…) ; `entreprise` (raison sociale, ENT_… ou id) rattache " +
        "contacts et participants. Simulation par défaut (dry_run=true) : à relire avant d'exécuter.",
      inputSchema: {
        type: z.enum(["entreprises", "contacts", "participants", "particuliers"]),
        lignes: z.array(LIGNE).min(1).max(MAX_LIGNES),
        mettre_a_jour: z.boolean().default(false),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const endpoint = args.type === "entreprises" ? "entreprises.php" : args.type === "participants" ? "participants.php" : "contacts.php";
      const cle = args.type === "entreprises" ? "id_entreprise" : args.type === "participants" ? "id_participant" : "id_contact";
      const entreprises = new Map<string, Row | null>();
      type Plan = { ligne: number; libelle: string; action: "creer" | "mettre_a_jour" | "ignorer"; raison?: string; body?: Row };
      const plan: Plan[] = [];
      const vus = new Set<string>();
      for (const [i, brut] of args.lignes.entries()) {
        const { entreprise, ...l } = brut;
        const body: Row = { ...l };
        const libelle = String(l.raison_sociale ?? (`${l.prenom ?? ""} ${l.nom ?? ""}`.trim() || l.email || `ligne ${i + 1}`));
        let ent: Row | undefined;
        if (entreprise !== undefined) {
          const k = String(entreprise);
          if (!entreprises.has(k)) {
            const r = await findEntreprise(client, k);
            entreprises.set(k, r.length === 1 ? r[0] : null);
          }
          const e = entreprises.get(k);
          if (!e) { plan.push({ ligne: i + 1, libelle, action: "ignorer", raison: `entreprise « ${k} » introuvable ou ambiguë` }); continue; }
          ent = e;
          body.id_entreprise = e.id_entreprise;
        }
        if (args.type === "entreprises" ? !l.raison_sociale : !l.nom) { plan.push({ ligne: i + 1, libelle, action: "ignorer", raison: args.type === "entreprises" ? "raison_sociale manquante" : "nom manquant" }); continue; }
        if (args.type === "contacts" && !ent) { plan.push({ ligne: i + 1, libelle, action: "ignorer", raison: "entreprise requise pour un contact" }); continue; }
        const doublonCle = normalize(args.type === "entreprises" ? l.siret || l.raison_sociale : l.email || `${l.prenom} ${l.nom}`);
        if (vus.has(doublonCle)) { plan.push({ ligne: i + 1, libelle, action: "ignorer", raison: "doublon dans la liste" }); continue; }
        vus.add(doublonCle);
        let existant: Row | undefined;
        if (args.type === "entreprises") {
          if (l.siret) existant = (await client.list(endpoint, { siret: String(l.siret) }))[0];
          existant ??= (await client.list(endpoint, { search: String(l.raison_sociale) })).find((e) => normalize(e.raison_sociale) === normalize(l.raison_sociale));
        } else if (l.email) {
          const trouves = await client.list(endpoint, { email: String(l.email) });
          existant = args.type === "particuliers" ? trouves.find((c) => vrai(c.particulier)) : trouves.find((c) => !ent || String(c.id_entreprise) === String(ent.id_entreprise));
        }
        if (args.type === "particuliers") body.particulier = 1;
        if (existant && !args.mettre_a_jour) plan.push({ ligne: i + 1, libelle, action: "ignorer", raison: `existe déjà (${cle} ${existant[cle]})` });
        else if (existant) plan.push({ ligne: i + 1, libelle, action: "mettre_a_jour", body: { [cle]: existant[cle], ...body } });
        else plan.push({ ligne: i + 1, libelle, action: "creer", body });
      }
      const compte = (a: Plan["action"]) => plan.filter((p) => p.action === a).length;
      const recap = {
        type: args.type,
        a_creer: compte("creer"),
        a_mettre_a_jour: compte("mettre_a_jour"),
        ignorees: compte("ignorer"),
        lignes: plan.map((p) => ({ ligne: p.ligne, fiche: p.libelle, action: p.action, raison: p.raison })),
      };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      const journal: string[] = [];
      for (const p of plan.filter((x) => x.body)) {
        try {
          await client.post(args.type === "particuliers" && p.action === "mettre_a_jour" ? "particuliers.php" : endpoint, p.body!);
          journal.push(`ligne ${p.ligne} ${p.libelle} : ${p.action === "creer" ? "créée" : "mise à jour"}`);
        } catch (e) {
          journal.push(`ligne ${p.ligne} ${p.libelle} : erreur : ${(e as Error).message}`);
        }
      }
      return json({ ok: true, ...recap, journal });
    },
  );

  server.registerTool(
    "preinscriptions",
    {
      title: "Pré-inscriptions du catalogue à traiter",
      description:
        "Sessions qui ont reçu des pré-inscriptions depuis le catalogue public, avec le détail par statut (à traiter, en attente, " +
        "paiement en attente, validées, refusées). Par défaut, seulement les sessions avec des pré-inscriptions à traiter.",
      inputSchema: {
        a_traiter_seulement: z.boolean().default(true),
        debut_apres: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Sessions commençant à partir de cette date (défaut : aujourd'hui)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = await client.list("actions_de_formation.php", { include: "preinscriptions", started_after: args.debut_apres ?? today(), fields: "id_action_de_formation,numero_complet,intitule,date_debut" });
      const sessions = rows
        .map((r) => ({ r, p: (r.preinscriptions ?? {}) as Row }))
        .filter(({ p }) => num(p.nb_preinscriptions) > 0 && (!args.a_traiter_seulement || num(p.nb_preinscriptions_a_traiter) > 0))
        .map(({ r, p }) => ({ session: `${r.numero_complet} — ${r.intitule}`, debut: r.date_debut, preinscriptions: p }));
      return json({ nombre_sessions: sessions.length, sessions });
    },
  );

  server.registerTool(
    "supprimer_session",
    {
      title: "Supprimer une session",
      description:
        "Supprime une action de formation, avec garde-fous : refusé si des participants sont inscrits ou si des présences sont " +
        "saisies (annuler d'abord les inscriptions, ou passer la session à l'étape « Annulée » avec `modifier_session`). " +
        "Par défaut dry_run=true. Irréversible : ne relancer avec dry_run=false qu'après confirmation explicite.",
      inputSchema: { session: z.string().describe("Id ou numéro complet (ADF_…)"), dry_run: z.boolean().default(true) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule,date_debut"), "Session");
      if (!("row" in s)) return json(s);
      const id = String(s.row.id_action_de_formation);
      const [laps, lcps, factures] = await Promise.all([
        inscriptionsSession(client, id),
        client.list("lcps.php", { id_action_de_formation: id }),
        client.list("factures.php", { id_action_de_formation: id }),
      ]);
      const bloquants: string[] = [];
      if (laps.length) bloquants.push(`${laps.length} participant(s) inscrit(s)`);
      if (lcps.some((p) => vrai(p.presence) || num(p.total_heures_absence) > 0)) bloquants.push("des présences ou absences sont saisies");
      if (factures.length) bloquants.push(`${factures.length} facture(s) liée(s)`);
      const recap = { session: `${s.row.numero_complet} — ${s.row.intitule}`, debut: s.row.date_debut };
      if (bloquants.length) return json({ erreur: "Suppression refusée.", bloquants, ...recap });
      return appliquer(args.dry_run, { action: "suppression", ...recap }, () => client.delete("actions_de_formation.php", { id }));
    },
  );

  server.registerTool(
    "supprimer_fiche",
    {
      title: "Supprimer une fiche CRM",
      description:
        "Supprime un participant, un contact, une entreprise ou une action commerciale, avec garde-fous (participant inscrit à des " +
        "sessions, entreprise avec inscriptions : refusé). Supprimer le contact d'un particulier supprime tout le particulier. " +
        "Une entreprise supprimée peut être restaurée avec `restaurer_entreprise`. Par défaut dry_run=true ; ne relancer avec " +
        "dry_run=false qu'après confirmation explicite.",
      inputSchema: {
        type: z.enum(["participant", "contact", "entreprise", "action_commerciale"]),
        id: z.string().describe("Id de la fiche"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const cfg = {
        participant: { endpoint: "participants.php", cle: "id_participant" },
        contact: { endpoint: "contacts.php", cle: "id_contact" },
        entreprise: { endpoint: "entreprises.php", cle: "id_entreprise" },
        action_commerciale: { endpoint: "actions_commerciales.php", cle: "id_action_commerciale" },
      }[args.type];
      const [fiche] = await client.list(cfg.endpoint, { id: args.id });
      if (!fiche) return json({ erreur: "Fiche introuvable." });
      const bloquants: string[] = [];
      const avertissements: string[] = [];
      if (args.type === "participant") {
        const laps = await client.list("laps.php", { id_participant: args.id });
        if (laps.length) bloquants.push(`inscrit à ${laps.length} session(s)`);
      } else if (args.type === "entreprise") {
        const [laps, contacts, participants] = await Promise.all([
          client.list("laps.php", { id_entreprise: args.id }),
          client.list("contacts.php", { id_entreprise: args.id, fields: "id_contact" }),
          client.list("participants.php", { id_entreprise: args.id, fields: "id_participant" }),
        ]);
        if (laps.length) bloquants.push(`${laps.length} inscription(s) à des sessions`);
        if (contacts.length || participants.length) avertissements.push(`${contacts.length} contact(s) et ${participants.length} participant(s) rattachés`);
      } else if (args.type === "contact" && vrai(fiche.particulier)) {
        avertissements.push("Contact d'un particulier : la suppression entraîne celle du particulier complet (contact, entreprise et participant).");
      }
      const libelle = String(fiche.raison_sociale ?? nomDe(fiche) ?? fiche.titre ?? args.id);
      if (bloquants.length) return json({ erreur: "Suppression refusée.", bloquants, fiche: libelle });
      return appliquer(args.dry_run, { action: "suppression", type: args.type, fiche: libelle, ...(avertissements.length ? { avertissements } : {}) }, () =>
        client.delete(cfg.endpoint, { id: args.id }),
      );
    },
  );

  server.registerTool(
    "restaurer_entreprise",
    {
      title: "Restaurer une entreprise supprimée",
      description: "Restaure une entreprise supprimée, à partir de son id. Par défaut dry_run=true.",
      inputSchema: { id_entreprise: z.string(), dry_run: z.boolean().default(true) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => appliquer(args.dry_run, { action: "restauration", id_entreprise: args.id_entreprise }, () =>
      client.post("entreprises.php", { id: args.id_entreprise, restore: 1 }),
    ),
  );
}
