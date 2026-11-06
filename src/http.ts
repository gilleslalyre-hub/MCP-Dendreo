import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const given = url.searchParams.get("token") ?? bearer ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Mode sans état : un serveur et un transport par requête (adapté aux fonctions serverless).
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, body?: unknown) {
  if (!authorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  // @hono/node-server ajoute un Content-Length numérique qui, combiné à l'en-tête Connection,
  // fait annoncer « Transfer-Encoding: chunked » sans découper le corps : les clients reçoivent
  // une réponse tronquée. On laisse Node gérer lui-même la longueur.
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  (res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args: unknown[]) => {
    const headers = args.find((a) => a !== null && typeof a === "object" && !Array.isArray(a)) as Record<string, unknown> | undefined;
    if (headers) for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length") delete headers[k];
    return writeHead(...args);
  };
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
