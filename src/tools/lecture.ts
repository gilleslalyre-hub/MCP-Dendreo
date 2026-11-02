import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { findEntreprise, findEtape, findFormateur, findModule, findSalle, findSession, single } from "./resolve.js";
import { LIMITE, borner, json, splitDateTime } from "./util.js";

const nomDe = (p: unknown) => {
  const r = (p ?? {}) as Row;
  return [r.prenom, r.nom].filter(Boolean).join(" ") || undefined;
};

function creneau(c: Row) {
  const debut = splitDateTime(c.date_debut);
  return {
    id_creneau: c.id_creneau,
    date: debut.date,
    debut: debut.heure,
    fin: splitDateTime(c.date_fin).heure,
    intitule: c.name || undefined,
    id_lam: c.id_lam,
    formateurs: Array.isArray(c.formateurs) ? (c.formateurs as Row[]).map(nomDe) : undefined,
  };
}

export function registerLectureTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "detail_session",
    {
      description:
        "Fiche complète d'une action de formation : informations générales, remplissage, modules programmés, " +
        "créneaux (dates, heures, formateurs), formateurs staffés et participants inscrits.",
      inputSchema: {
        session: z.string().describe("Id de l'action de formation (ex. 365) ou numéro complet (ex. ADF_20260048)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session }) => {
      const r = single(await findSession(client, session), "Session");
      if (!("row" in r)) return json(r);
      const adf = r.row;
      const id = String(adf.id_action_de_formation);
      const [lams, creneaux, laps, lafs] = await Promise.all([
        client.list("lams.php", { id_action_de_formation: id }),
        client.list("creneaux.php", { id_action_de_formation: id, include: "formateurs" }),
        client.list("laps.php", { id_action_de_formation: id, include: "participant" }),
        client.list("lafs.php", { id_action_de_formation: id }),
      ]);
      return json({
        session: {
          id,
          numero: adf.numero_complet,
          intitule: adf.intitule,
          type: adf.type,
          date_debut: adf.date_debut,
          date_fin: adf.date_fin,
          id_etape_process: adf.id_etape_process,
          id_entreprise: adf.id_entreprise && String(adf.id_entreprise) !== "0" ? adf.id_entreprise : undefined,
          inscrits: adf.nb_participants_inscrits,
          en_attente: adf.nb_participants_en_attente,
          places_min: adf.nb_participants_min,
          places_max: adf.nb_participants_max,
        },
        modules: lams.map((l) => ({
          id_lam: l.id_lam,
          id_module: l.id_module,
          intitule: l.intitule ?? l.intitule_module,
          date_debut: l.date_debut,
          date_fin: l.date_fin,
          seance_alternative: l.id_shadow_lam && String(l.id_shadow_lam) !== "0" ? true : undefined,
          formateurs: Array.isArray(l.formateurs) ? (l.formateurs as Row[]).map(nomDe) : undefined,
        })),
        creneaux: creneaux.map(creneau).sort((a, b) => `${a.date}${a.debut}`.localeCompare(`${b.date}${b.debut}`)),
        formateurs: lafs.map((f) => ({ id_laf: f.id_laf, id_formateur: f.id_formateur, nom: nomDe(f.formateur) })),
        participants: laps.map((p) => {
          const part = (p.participant ?? {}) as Row;
          return {
            id_lap: p.id_lap,
            id_participant: p.id_participant,
            nom: nomDe(part) ?? (String(p.id_participant) === "0" ? "Participant non identifié" : undefined),
            email: part.email || undefined,
            id_entreprise: p.id_entreprise,
          };
        }),
      });
    },
  );

  server.registerTool(
    "rechercher_participant",
    {
      description:
        "Recherche des participants par email, nom ou date de naissance, et affiche leurs formations " +
        "(sessions auxquelles ils sont inscrits).",
      inputSchema: {
        recherche: z.string().describe("Email, nom, ou date de naissance"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ recherche }) => {
      const participants = await client.list("participants.php", {
        search: recherche,
        fields: "id_participant,civilite,nom,prenom,email,fonction,id_entreprise",
      });
      const top = participants.slice(0, 5);
      const result = await Promise.all(
        top.map(async (p) => {
          const laps = await client.list("laps.php", {
            id_participant: String(p.id_participant),
            include: "action_de_formation",
          });
          return {
            ...p,
            formations: laps
              .map((l) => {
                const a = (l.action_de_formation ?? {}) as Row;
                return {
                  id_action_de_formation: l.id_action_de_formation,
                  numero: a.numero_complet,
                  intitule: a.intitule,
                  date_debut: a.date_debut,
                  date_fin: a.date_fin,
                };
              })
              .sort((a, b) => String(b.date_debut).localeCompare(String(a.date_debut))),
          };
        }),
      );
      return json({
        nombre_trouves: participants.length,
        participants: result,
        ...(participants.length > top.length ? { note: "Seuls les 5 premiers sont détaillés : affiner la recherche." } : {}),
      });
    },
  );

  server.registerTool(
    "catalogue",
    {
      description:
        "Consulte les référentiels Dendreo : modules de formation (durée, prix, formateurs aptes), formateurs, " +
        "entreprises, salles et étapes des actions de formation.",
      inputSchema: {
        objet: z.enum(["modules", "formateurs", "entreprises", "salles", "etapes"]),
        recherche: z.string().optional().describe("Filtre : intitulé, nom, raison sociale…"),
        limite: LIMITE,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ objet, recherche, limite }) => {
      const liste = (rows: Row[]) => {
        const { items, total, avertissement } = borner(rows, limite);
        return json(total ? { nombre: total, avertissement, resultats: items } : items);
      };
      switch (objet) {
        case "modules": {
          const rows = recherche
            ? await findModule(client, recherche)
            : await client.list("modules.php", { fields: "id_module,intitule,numero_complet" });
          if (rows.length === 0 || rows.length > 20) {
            return liste(rows);
          }
          const details = await client.list("modules.php", {
            id: rows.map((r) => r.id_module).join(","),
            include: "formateurs_aptes",
          });
          return json(
            details.map((m) => ({
              id_module: m.id_module,
              numero: m.numero_complet,
              intitule: m.intitule,
              duree_heures: m.duree_heures,
              duree_jours: m.duree_jours,
              prix_inter: m.prix,
              prix_intra: m.prix_intra,
              places_min: m.nb_participants_min,
              places_max: m.nb_participants_max,
              mode_organisation: m.mode_organisation,
              formateurs_aptes: Array.isArray(m.formateurs_aptes) ? (m.formateurs_aptes as Row[]).map(nomDe) : [],
            })),
          );
        }
        case "formateurs":
          return liste(
            recherche
              ? await findFormateur(client, recherche)
              : await client.list("formateurs.php", { fields: "id_formateur,nom,prenom,email_pro" }),
          );
        case "entreprises":
          return json(
            recherche
              ? await findEntreprise(client, recherche)
              : { erreur: "Préciser une recherche (raison sociale, numéro ENT_…)." },
          );
        case "salles":
          return liste(
            recherche
              ? await findSalle(client, recherche)
              : await client.list("salles_de_formation.php", { fields: "id_salle_de_formation,intitule,ville" }),
          );
        case "etapes":
          return liste(
            (recherche ? await findEtape(client, recherche) : await client.list("etapes.php")).map((e) => ({
              id_etape_process: e.id_etape_process,
              intitule: e.intitule,
              cible: e.cible,
            })),
          );
      }
    },
  );
}
