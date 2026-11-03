import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Sérialise en JSON compact en omettant les clés vides (null, "", dates « 0000-00-00 ») :
 * les fiches brutes Dendreo en contiennent beaucoup, et chacune coûte des tokens.
 */
export function serialiser(data: unknown): string {
  return JSON.stringify(data, function (_k, v) {
    if (typeof v === "string") v = dateCourte(v);
    if (Array.isArray(this)) return v;
    return v === null || v === "" || (typeof v === "string" && v.startsWith("0000-00-00")) ? undefined : v;
  });
}

/** « AAAA-MM-JJ 00:00:00 » → « AAAA-MM-JJ » ; « AAAA-MM-JJ HH:MM:00 » → « AAAA-MM-JJ HH:MM ». */
function dateCourte(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):(\d{2})$/.exec(v);
  if (!m || m[3] !== "00") return v;
  return m[2] === "00:00" ? m[1] : `${m[1]} ${m[2]}`;
}

/** Clés utiles d'une réponse d'écriture Dendreo (souvent la fiche complète) : ids, numéro, statut, liens, erreurs. */
const CLE_UTILE = /^(id(_.*)?|numero_complet|status|success|message|errors?|public_url|url)$/;

/** Réduit la réponse d'une écriture à ce qui sert à la suite de la conversation. */
export function resumeReponse(r: unknown): unknown {
  if (Array.isArray(r)) return r.length > 20 ? { nombre: r.length, extrait: r.slice(0, 20).map(resumeReponse) } : r.map(resumeReponse);
  if (!r || typeof r !== "object") return r;
  const garde = Object.entries(r).filter(([k, v]) => CLE_UTILE.test(k) && (v === null || typeof v !== "object"));
  if (garde.length) return Object.fromEntries(garde);
  return JSON.stringify(r).length <= 300 ? r : { champs_renvoyes: Object.keys(r).length };
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: serialiser(data) }] };
}

/** Date AAAA-MM-JJ (message explicite : le motif n'est pas annoncé dans le schéma, cf. slim.ts). */
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format attendu AAAA-MM-JJ");

/** Date du jour au format AAAA-MM-JJ, fuseau Europe/Paris. */
export function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
}

/** Premier et dernier jour d'un mois AAAA-MM. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { first: `${y}-${mm}-01`, last: `${y}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

/** Comparaison insensible à la casse et aux accents. */
export function normalize(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Ajoute n jours à une date AAAA-MM-JJ. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sépare « AAAA-MM-JJ HH:MM:SS » en date et heure HH:MM. */
export function splitDateTime(value: unknown): { date: string; heure: string } {
  const s = String(value ?? "");
  return { date: s.slice(0, 10), heure: s.slice(11, 16) };
}

/** « Prénom Nom » d'un participant ou formateur renvoyé par Dendreo. */
export function nomDe(p: unknown): string | undefined {
  const r = (p ?? {}) as Record<string, unknown>;
  return [r.prenom, r.nom].filter(Boolean).join(" ") || undefined;
}

/** Valeur Dendreo « vraie » (1, "1", true). */
export const vrai = (v: unknown) => v === true || String(v) === "1";

/** Champs personnalisés Dendreo, passés tels quels à l'API sous leur nom technique. */
export const CHAMPS_PERSONNALISES = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe("Champs additionnels par nom technique");

/** Nombre issu d'une valeur Dendreo (chaîne vide ou absente → 0). */
export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Arrondi à 2 décimales. */
export const arrondi = (n: number): number => Math.round(n * 100) / 100;

/** Découpe une liste en lots (les filtres multi-ids passent en `?id=1,2,3`). */
export function lots<T>(items: T[], taille = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += taille) out.push(items.slice(i, i + taille));
  return out;
}

/** Durée en heures entre deux « AAAA-MM-JJ HH:MM:SS » d'un créneau. */
export function heuresCreneau(c: Record<string, unknown>): number {
  const a = Date.parse(`${String(c.date_debut).replace(" ", "T")}Z`);
  const b = Date.parse(`${String(c.date_fin).replace(" ", "T")}Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 3_600_000 : 0;
}

/** Date Dendreo renseignée (ni vide ni « 0000-00-00 »). */
export const dateRenseignee = (v: unknown): boolean => !!v && !String(v).startsWith("0000");

/** Paramètre `limite` commun aux outils de liste. */
export const LIMITE = z.number().int().min(1).max(500).optional().describe("défaut 50");

/**
 * Borne une liste pour limiter la taille de la réponse : renvoie `items` (tronqué) et,
 * si la liste a été coupée, `total` et un avertissement.
 */
export function borner<T>(items: T[], limite = 50): { items: T[]; total?: number; avertissement?: string } {
  if (items.length <= limite) return { items };
  return { items: items.slice(0, limite), total: items.length, avertissement: `${items.length - limite} lignes non affichées : affiner les filtres ou augmenter \`limite\`.` };
}

/** Retire les valeurs vides (undefined, null, chaîne vide) d'un objet pour alléger le JSON. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}
