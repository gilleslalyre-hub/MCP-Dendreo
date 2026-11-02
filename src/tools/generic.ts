import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient } from "../dendreo/client.js";
import { json } from "./util.js";

const MAX_CARS = 12_000;

// Outil de lecture générique de secours (endpoints sans outil métier dédié).
export function registerGenericTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "dendreo_get",
    {
      title: "Lire une ressource Dendreo",
      description:
        "Appel GET en lecture seule sur l'API Dendreo. `endpoint` est le fichier de ressource " +
        "(ex. participants.php). Préférer les outils métier ; toujours passer `fields` dans `params` pour limiter la réponse.",
      inputSchema: {
        endpoint: z.string().describe("Ressource Dendreo, ex. participants.php"),
        params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Paramètres de requête, ex. { id_participant: 42 }"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, params }) => {
      const data = await client.get(endpoint, params);
      const texte = JSON.stringify(data);
      if (texte.length <= MAX_CARS) return { content: [{ type: "text", text: texte }] };
      const extrait = Array.isArray(data) ? JSON.stringify(data.slice(0, Math.max(1, Math.floor((MAX_CARS / texte.length) * data.length)))) : texte.slice(0, MAX_CARS);
      return json({ tronque: true, total_cars: texte.length, avertissement: "Réponse tronquée : ajouter `fields` et des filtres dans `params`.", extrait: Array.isArray(data) ? JSON.parse(extrait) : extrait });
    },
  );
}
