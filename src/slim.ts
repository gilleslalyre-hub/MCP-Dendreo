// Allège la liste des outils envoyée au modèle (tools/list), chargée dans le contexte à chaque conversation.
// Seul le schéma *annoncé* est réduit : la validation zod côté serveur reste complète.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

/** Motifs de dates (AAAA-MM-JJ, AAAA-MM) : déjà annoncés une fois dans les instructions du serveur. */
const MOTIFS_DATE = new Set(["^\\d{4}-\\d{2}-\\d{2}$", "^\\d{4}-\\d{2}$"]);

function allegerSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(allegerSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const o = node as Record<string, unknown>;
  // Un `enum` de chaînes suffit à typer la valeur : `"type":"string"` est redondant.
  const enumTexte = Array.isArray(o.enum) && o.enum.every((e) => typeof e === "string");
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema") continue;
    if (k === "type" && v === "string" && enumTexte) continue;
    if (k === "additionalProperties" && v === false) continue;
    if (k === "pattern" && typeof v === "string" && MOTIFS_DATE.has(v)) continue;
    out[k] = k === "description" && typeof v === "string" ? v.replace(/\s+/g, " ").trim() : allegerSchema(v);
  }
  return out;
}

/** Cible d'une référence locale « #/a/b/c » dans le schéma racine. */
function cible(racine: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let n: unknown = racine;
  for (const k of ref.slice(2).split("/")) n = n && typeof n === "object" ? (n as Record<string, unknown>)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return n;
}

/**
 * Remplace chaque `$ref` local par sa cible quand celle-ci est plus courte que la référence
 * (ex. `{"$ref":"#/properties/ajouter/items/properties/heure_debut"}` → `{"type":"string",…}`).
 */
function inlinerRefs(node: unknown, racine: unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => inlinerRefs(n, racine));
  if (!node || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  if (typeof o.$ref === "string") {
    const t = cible(racine, o.$ref);
    if (t && typeof t === "object" && !JSON.stringify(t).includes('"$ref"') && JSON.stringify(t).length <= JSON.stringify(o).length + 20) {
      const { $ref: _ignore, ...reste } = o;
      return { ...(t as Record<string, unknown>), ...reste };
    }
    return o;
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, inlinerRefs(v, racine)]));
}

/** Remplace le gestionnaire tools/list du SDK par une version allégée (calculée une fois). */
export function allegerListeOutils(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<ListToolsResult>> })._requestHandlers;
  const original = handlers.get("tools/list");
  if (!original) return;
  let cache: ListToolsResult | undefined;
  handlers.set("tools/list", async (req, extra) => {
    cache ??= {
      tools: (await original(req, extra)).tools.map(({ execution, ...t }) => ({
        ...t,
        description: t.description?.replace(/\s+/g, " ").trim(),
        inputSchema: allegerSchema(inlinerRefs(t.inputSchema, t.inputSchema)) as typeof t.inputSchema,
        // `taskSupport: "forbidden"` est la valeur par défaut : inutile de la répéter pour chaque outil.
        ...(execution && execution.taskSupport !== "forbidden" ? { execution } : {}),
      })),
    };
    return cache;
  });
}
