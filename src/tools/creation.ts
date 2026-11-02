import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { findEntreprise, findEtape, findFormateur, findModule, findSalle, single } from "./resolve.js";
import { CHAMPS_PERSONNALISES, json } from "./util.js";

type Slot = { date: string; heure_debut: string; heure_fin: string };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HORAIRES = /^\d{2}:\d{2}-\d{2}:\d{2}(;\d{2}:\d{2}-\d{2}:\d{2})*$/;

function slotsFor(dates: string[], horaires: string): Slot[] {
  return [...dates].sort().flatMap((date) =>
    horaires.split(";").map((plage) => {
      const [heure_debut, heure_fin] = plage.split("-");
      return { date, heure_debut, heure_fin };
    }),
  );
}

const slotKey = (s: Slot) => `${s.date} ${s.heure_debut}-${s.heure_fin}`;

function slotOf(c: Row): Slot {
  const debut = String(c.date_debut);
  return { date: debut.slice(0, 10), heure_debut: debut.slice(11, 16), heure_fin: String(c.date_fin).slice(11, 16) };
}

export const CREER_SESSION = {
  formation: z.string().describe("Intitulé du module de formation, ex. « Product Builder »"),
  formateur: z.string().describe("Prénom et nom du formateur, ex. « Clément Brottier »"),
  dates: z.array(DATE).min(1).describe("Jours de formation (AAAA-MM-JJ), pas forcément consécutifs"),
  horaires: z
    .string()
    .regex(HORAIRES)
    .default("09:00-12:30;13:30-17:00")
    .describe("Plages horaires de chaque jour, ex. 09:00-12:30;13:30-17:00"),
  type: z.enum(["inter", "intra"]).default("inter").describe("inter (multi-entreprises) ou intra (une entreprise)"),
  entreprise: z.string().optional().describe("Obligatoire si type=intra : raison sociale, numéro ENT_… ou id"),
  id_entreprise: z.number().int().optional().describe("Alternative à entreprise"),
  etape: z.string().optional().describe("Étape de l'ADF (ex. « Prévisionnelle »). Par défaut celle configurée dans Dendreo"),
  salle: z.string().optional().describe("Salle de formation (intitulé ou id). Par défaut celle du module"),
  prix: z.number().optional().describe("Prix personnalisé. Par défaut celui du module"),
  places_min: z.number().int().optional(),
  places_max: z.number().int().optional(),
  id_responsable: z.number().int().optional().describe("Administrateur Dendreo responsable de la session"),
  intitule: z.string().optional().describe("Intitulé de la session, par défaut celui du module"),
  id_module: z.number().int().optional().describe("À fournir si plusieurs modules correspondent"),
  id_formateur: z.number().int().optional().describe("À fournir si plusieurs formateurs correspondent"),
  champs_personnalises: CHAMPS_PERSONNALISES,
  dry_run: z.boolean().default(true).describe("true = simulation sans écriture"),
};

export type CreerSessionArgs = z.infer<z.ZodObject<typeof CREER_SESSION>>;

/** Crée une session complète (ADF, créneaux, staffing) ; en dry_run renvoie seulement le plan. */
export async function creerSession(client: DendreoClient, args: CreerSessionArgs): Promise<CallToolResult> {
  if (args.type === "intra" && !args.id_entreprise && !args.entreprise) {
    return json({ erreur: "L'entreprise est obligatoire pour une session intra." });
  }
  const extra: Row = {};
  const libelles: Row = {};
  if (args.entreprise) {
    const r = single(await findEntreprise(client, args.entreprise), "Entreprise");
    if (!("row" in r)) return json(r);
    extra.id_entreprise = r.row.id_entreprise;
    libelles.entreprise = r.row.raison_sociale;
  } else if (args.id_entreprise) {
    extra.id_entreprise = args.id_entreprise;
  }
  if (args.etape) {
    const r = single(await findEtape(client, args.etape), "Étape");
    if (!("row" in r)) return json(r);
    extra.id_etape_process = r.row.id_etape_process;
    libelles.etape = r.row.intitule;
  }
  if (args.salle) {
    const r = single(await findSalle(client, args.salle), "Salle");
    if (!("row" in r)) return json(r);
    extra.id_salle_de_formation = r.row.id_salle_de_formation;
    libelles.salle = r.row.intitule;
  }
  if (args.prix !== undefined) extra.prix = args.prix;
  if (args.places_min !== undefined) extra.nb_participants_min = args.places_min;
  if (args.places_max !== undefined) extra.nb_participants_max = args.places_max;
  if (args.id_responsable !== undefined) extra.id_responsable = args.id_responsable;

  const modules = args.id_module
    ? await client.list("modules.php", { id: args.id_module, fields: "id_module,intitule,numero_complet" })
    : await findModule(client, args.formation);
  const formateurs = args.id_formateur
    ? await client.list("formateurs.php", { id: args.id_formateur, fields: "id_formateur,nom,prenom,email_pro" })
    : await findFormateur(client, args.formateur);

  if (modules.length !== 1 || formateurs.length !== 1) {
    return json({
      erreur: "Formation ou formateur introuvable ou ambigu : préciser id_module / id_formateur.",
      modules_trouves: modules,
      formateurs_trouves: formateurs,
    });
  }
  const [module] = modules;
  const [formateur] = formateurs;
  const slots = slotsFor(args.dates, args.horaires);
  const dates = slots.map((s) => s.date);
  const adf: Row = {
    type: args.type,
    intitule: args.intitule ?? module.intitule,
    include_in_bpf: 1,
    date_debut: dates[0],
    date_fin: dates[dates.length - 1],
    id_module: module.id_module,
    id_formateur: formateur.id_formateur,
    ...extra,
    ...args.champs_personnalises,
  };

  const plan = {
    module,
    formateur,
    ...libelles,
    action_de_formation: adf,
    creneaux: slots.map(slotKey),
  };
  if (args.dry_run) {
    return json({ dry_run: true, message: "Rien n'a été créé. Relancer avec dry_run=false après confirmation.", ...plan });
  }

  // À partir d'ici l'ADF existe : on renvoie l'état partiel plutôt que de lever une erreur.
  const journal: string[] = [];
  const created = (await client.post("actions_de_formation.php", adf)) as Row;
  const idAdf = created.id_action_de_formation;
  journal.push(`ADF créée : id ${idAdf} (${created.numero_complet ?? ""})`);
  try {
    const lams = await client.list("lams.php", { id_action_de_formation: String(idAdf) });
    const lam = lams.find((l) => String(l.id_module) === String(module.id_module)) ?? lams[0];
    if (!lam) throw new Error("aucune programmation (lam) trouvée pour le module");

    // Dendreo peut générer un planning par défaut : on l'aligne exactement sur les jours demandés.
    const wanted = new Set(slots.map(slotKey));
    const existing = await client.list("creneaux.php", { id_action_de_formation: String(idAdf) });
    const kept = new Set<string>();
    const extra: Row[] = [];
    for (const c of existing) {
      const key = slotKey(slotOf(c));
      if (wanted.has(key) && !kept.has(key)) kept.add(key);
      else extra.push(c);
    }
    if (extra.length > 0) {
      await client.delete("creneaux.php", { id: extra.map((c) => c.id_creneau).join(",") });
      journal.push(`Créneaux par défaut retirés : ${extra.map((c) => slotKey(slotOf(c))).join(", ")}`);
    }
    for (const s of slots.filter((s) => !kept.has(slotKey(s)))) {
      await client.post("creneaux.php", { id_lam: lam.id_lam, ...s });
      journal.push(`Créneau ajouté : ${slotKey(s)}`);
    }

    const creneaux = await client.list("creneaux.php", { id_action_de_formation: String(idAdf) });
    const staffed = new Set(
      (await client.list("lcfs.php", { id_action_de_formation: String(idAdf), id_formateur: String(formateur.id_formateur) }))
        .filter((l) => String(l.status) === "1")
        .map((l) => String(l.id_creneau)),
    );
    for (const c of creneaux.filter((c) => !staffed.has(String(c.id_creneau)))) {
      await client.post("lcfs.php", { id_creneau: c.id_creneau, id_formateur: formateur.id_formateur, status: 1 });
    }
    journal.push(`Formateur ${formateur.prenom} ${formateur.nom} staffé sur ${creneaux.length} créneau(x)`);
    return json({ ok: true, id_action_de_formation: idAdf, journal, creneaux: creneaux.map((c) => slotKey(slotOf(c))) });
  } catch (e) {
    journal.push(`Erreur : ${(e as Error).message}`);
    return json({ ok: false, id_action_de_formation: idAdf, journal, message: "Session créée mais incomplète : vérifier dans Dendreo." });
  }
}

export function registerCreationTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "creer_session",
    {
      description:
        "Crée une action de formation (session) pour un module du catalogue, sur des jours précis, avec un formateur staffé " +
        "sur tous les créneaux. Par défaut dry_run=true : rien n'est écrit, l'outil renvoie ce qui serait créé. " +
        "Montrer ce récapitulatif à l'utilisateur et ne relancer avec dry_run=false qu'après sa confirmation explicite.",
      inputSchema: CREER_SESSION,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => creerSession(client, args),
  );
}
