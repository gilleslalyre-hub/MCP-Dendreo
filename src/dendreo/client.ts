// Client HTTP minimal pour l'API Dendreo (https://developers.dendreo.com).
// Authentification par en-tête `Authorization: Token token="..."` (équivalent du paramètre `?key=`),
// ce qui évite que la clé apparaisse dans les URL et les logs.

export class DendreoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined>;
export type Row = Record<string, unknown>;

const ENDPOINT = /^[a-z0-9_]+\.php$/i;

export class DendreoClient {
  private readonly baseUrl: string;

  constructor(slug: string, private readonly apiKey: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? `https://pro.dendreo.com/${slug}/api/`;
  }

  static fromEnv(): DendreoClient {
    const slug = process.env.DENDREO_SLUG;
    const key = process.env.DENDREO_API_KEY;
    if (!slug || !key) throw new DendreoError("DENDREO_SLUG et DENDREO_API_KEY doivent être définis");
    return new DendreoClient(slug, key, process.env.DENDREO_BASE_URL);
  }

  get(endpoint: string, query: Query = {}): Promise<unknown> {
    return this.request("GET", endpoint, query);
  }

  /** GET qui renvoie toujours un tableau (Dendreo renvoie un objet pour un id unique). */
  async list(endpoint: string, query: Query = {}): Promise<Row[]> {
    const data = await this.get(endpoint, query);
    if (Array.isArray(data)) return data as Row[];
    return data && typeof data === "object" ? [data as Row] : [];
  }

  post(endpoint: string, body: Row): Promise<unknown> {
    return this.request("POST", endpoint, {}, body);
  }

  delete(endpoint: string, query: Query): Promise<unknown> {
    return this.request("DELETE", endpoint, query);
  }

  /** Envoie un fichier en multipart/form-data (champ `file`) avec des champs texte. */
  postFile(endpoint: string, fields: Row, file: { nom: string; contenu: Buffer; type?: string }): Promise<unknown> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    form.set("file", new Blob([new Uint8Array(file.contenu)], { type: file.type ?? "application/octet-stream" }), file.nom);
    return this.request("POST", endpoint, {}, form);
  }

  /** GET d'un fichier binaire (document généré, export) : contenu et métadonnées. */
  async download(endpoint: string, query: Query): Promise<{ contenu: Buffer; type: string; nom?: string }> {
    const res = await this.fetch("GET", endpoint, query);
    const contenu = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // Dendreo renvoie une erreur JSON (statut 200 ou non) si le document ne peut pas être généré.
    if (type.includes("json")) {
      throw new DendreoError(`Dendreo GET ${endpoint} : ${corpsCourt(contenu.toString("utf8"))}`, res.status);
    }
    const nom = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
    return { contenu, type, nom: nom ? decodeURIComponent(nom) : undefined };
  }

  private async fetch(method: string, endpoint: string, query: Query, body?: Row | FormData): Promise<Response> {
    if (!ENDPOINT.test(endpoint)) throw new DendreoError(`Endpoint invalide : ${endpoint}`);
    const url = new URL(endpoint, this.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Token token="${this.apiKey}"`,
      Accept: "application/json",
    };
    const isForm = body instanceof FormData;
    if (body && !isForm) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text();
      throw new DendreoError(`Dendreo ${method} ${endpoint} → ${res.status} : ${corpsCourt(text)}`, res.status);
    }
    return res;
  }

  private async request(method: string, endpoint: string, query: Query, body?: Row | FormData): Promise<unknown> {
    const text = await (await this.fetch(method, endpoint, query, body)).text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new DendreoError(`Réponse non JSON de ${endpoint} : ${corpsCourt(text, 150)}`);
    }
  }
}

/** Corps d'erreur condensé : balises HTML retirées, espaces compactés, tronqué (économie de tokens). */
function corpsCourt(texte: string, max = 200): string {
  const brut = texte.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return brut.length > max ? `${brut.slice(0, max)}…` : brut;
}
