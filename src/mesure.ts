// Mesure la taille des réponses de chaque outil (tools/call) pour repérer ceux qui consomment le plus de tokens.
// Une ligne JSON par appel dans les journaux (Vercel > Logs, rechercher « mcp_outil ») :
//   {"mcp_outil":"factures","cars":5210,"tokens_estimes":1489,"ms":840}
// Seuls le nom de l'outil et des tailles sont journalisés : jamais les arguments ni le contenu (données personnelles).
// Désactivable avec MCP_MESURE=0.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Handler = (req: { params?: { name?: string } }, extra: unknown) => Promise<CallToolResult>;

/** Ordre de grandeur pour du JSON en français (≈ 3,5 caractères par token). */
const CARS_PAR_TOKEN = 3.5;

export function mesurerAppels(server: McpServer): void {
  if (process.env.MCP_MESURE === "0") return;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const original = handlers.get("tools/call");
  if (!original) return;
  handlers.set("tools/call", async (req, extra) => {
    const debut = Date.now();
    const outil = req.params?.name ?? "?";
    try {
      const res = await original(req, extra);
      const cars = (res.content ?? []).reduce((n, c) => n + (c.type === "text" ? c.text.length : JSON.stringify(c).length), 0);
      console.log(JSON.stringify({ mcp_outil: outil, cars, tokens_estimes: Math.round(cars / CARS_PAR_TOKEN), ms: Date.now() - debut, ...(res.isError ? { erreur: true } : {}) }));
      return res;
    } catch (e) {
      console.log(JSON.stringify({ mcp_outil: outil, ms: Date.now() - debut, erreur: true }));
      throw e;
    }
  });
}
