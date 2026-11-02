import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { findEntreprise, findSession, single } from "./resolve.js";
import { json, normalize, today } from "./util.js";

const PARTICIPANT = z.object({
  email: z.string().email().optional(),
  prenom: z.string(),
  nom: z.string(),
  fonction: z.string().optional(),
});

type Ligne = {
  participant: string;
  action: "deja_inscrit" | "a_inscrire" | "a_creer_puis_inscrire" | "ambigu";
  id_participant?: unknown;
  avertissement?: string;
  resultat?: string;
};

/** Cherche un participant existant : par email s'il est fourni, sinon par nom + prénom. */
async function findParticipant(client: DendreoClient, p: z.infer<typeof PARTICIPANT>): Promise<Row[]> {
  const fields = "id_participant,nom,prenom,email,id_entreprise";
  if (p.email) return client.list("participants.php", { email: p.email, fields });
  const rows = await client.list("participants.php", { nom: p.nom, fields });
  return rows.filter((r) => normalize(r.prenom) === normalize(p.prenom));
}

export function registerInscriptionTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "inscrire_participants",
    {
      description:
        "Inscrit une liste de participants à une action de formation. Chaque participant est retrouvé par email " +
        "(ou nom + prénom) et créé dans le CRM s'il n'existe pas. Les participants déjà inscrits sont ignorés. " +
        "Permet aussi d'ajouter des participants non identifiés pour une entreprise.",
      inputSchema: {
        session: z.string(),
        entreprise: z
          .string()
          .optional()
          .describe("Entreprise des participants (raison sociale, ENT_… ou id). Par défaut celle de la session INTRA"),
        participants: z.array(PARTICIPANT).default([]),
        non_identifies: z.number().int().min(1).optional().describe("Nombre de participants non identifiés à ajouter"),
        dry_run: z.boolean().default(true).describe("true = simulation sans écriture"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = single(
        await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule,type,date_fin,id_entreprise"),
        "Session",
      );
      if (!("row" in s)) return json(s);
      const adf = s.row;
      const idAdf = String(adf.id_action_de_formation);

      let entreprise: Row | undefined;
      if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        entreprise = e.row;
      } else if (adf.type === "intra" && adf.id_entreprise && String(adf.id_entreprise) !== "0") {
        entreprise = { id_entreprise: adf.id_entreprise };
      }
      const idEntreprise = entreprise?.id_entreprise;
      if (args.non_identifies && !idEntreprise) {
        return json({ erreur: "Préciser l'entreprise pour ajouter des participants non identifiés." });
      }

      const inscrits = new Set(
        (await client.list("laps.php", { id_action_de_formation: idAdf })).map((l) => String(l.id_participant)),
      );
      const avertissements: string[] = [];
      if (String(adf.date_fin).slice(0, 10) < today()) avertissements.push("Cette session est terminée.");
      if (adf.type === "intra" && idEntreprise && String(idEntreprise) !== String(adf.id_entreprise)) {
        avertissements.push("Session INTRA : l'entreprise indiquée n'est pas celle de la session (accepté seulement si elle est du même groupe).");
      }

      const lignes: Ligne[] = [];
      for (const p of args.participants) {
        const label = `${p.prenom} ${p.nom}${p.email ? ` <${p.email}>` : ""}`;
        const found = await findParticipant(client, p);
        if (found.length > 1) {
          lignes.push({ participant: label, action: "ambigu", avertissement: "Plusieurs fiches correspondent : préciser l'email." });
          continue;
        }
        const existing = found[0];
        if (!existing) {
          lignes.push({ participant: label, action: "a_creer_puis_inscrire" });
        } else if (inscrits.has(String(existing.id_participant))) {
          lignes.push({ participant: label, action: "deja_inscrit", id_participant: existing.id_participant });
        } else {
          const autreEntreprise =
            idEntreprise && existing.id_entreprise && String(existing.id_entreprise) !== String(idEntreprise);
          lignes.push({
            participant: label,
            action: "a_inscrire",
            id_participant: existing.id_participant,
            ...(autreEntreprise ? { avertissement: "Fiche rattachée à une autre entreprise." } : {}),
          });
        }
      }

      const recap = {
        session: `${adf.numero_complet} — ${adf.intitule} (${adf.type})`,
        id_entreprise: idEntreprise,
        participants: lignes,
        ...(args.non_identifies ? { non_identifies: args.non_identifies } : {}),
        ...(avertissements.length ? { avertissements } : {}),
      };
      if (args.dry_run) {
        return json({ dry_run: true, message: "Rien n'a été écrit. Relancer avec dry_run=false après confirmation.", ...recap });
      }

      // Exécution ligne par ligne : une erreur sur un participant n'arrête pas les autres.
      for (const [i, l] of lignes.entries()) {
        if (l.action === "deja_inscrit" || l.action === "ambigu") {
          l.resultat = "ignoré";
          continue;
        }
        const p = args.participants[i];
        try {
          let idParticipant = l.id_participant;
          if (l.action === "a_creer_puis_inscrire") {
            const created = (await client.post("participants.php", {
              nom: p.nom,
              prenom: p.prenom,
              ...(p.email ? { email: p.email } : {}),
              ...(p.fonction ? { fonction: p.fonction } : {}),
              ...(idEntreprise ? { id_entreprise: idEntreprise } : {}),
            })) as Row;
            idParticipant = created.id_participant;
          }
          await client.post("laps.php", {
            id_action_de_formation: idAdf,
            id_participant: idParticipant,
            ...(idEntreprise ? { id_entreprise: idEntreprise } : {}),
          });
          l.id_participant = idParticipant;
          l.resultat = l.action === "a_creer_puis_inscrire" ? "créé et inscrit" : "inscrit";
        } catch (e) {
          l.resultat = `erreur : ${(e as Error).message}`;
        }
      }
      let nonIdentifies: string | undefined;
      if (args.non_identifies) {
        try {
          await client.post("laps.php", {
            id_action_de_formation: idAdf,
            id_entreprise: idEntreprise,
            nb_participants_anonymes: args.non_identifies,
          });
          nonIdentifies = `${args.non_identifies} ajouté(s)`;
        } catch (e) {
          nonIdentifies = `erreur : ${(e as Error).message}`;
        }
      }
      return json({ ...recap, ...(nonIdentifies ? { non_identifies: nonIdentifies } : {}) });
    },
  );
}
