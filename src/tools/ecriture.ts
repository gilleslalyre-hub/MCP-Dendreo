// Motif commun des écritures : simulation par défaut (dry_run=true), exécution sur confirmation.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DendreoError } from "../dendreo/client.js";
import { json, resumeReponse } from "./util.js";

export const messageErreur = (e: unknown): string =>
  e instanceof DendreoError && e.status === 422 ? `refusé par Dendreo : ${e.message}` : `erreur : ${(e as Error).message}`;

/** Renvoie le récapitulatif en simulation, sinon exécute `executer` et ajoute son résultat. */
export async function appliquer(
  dryRun: boolean,
  recap: Record<string, unknown>,
  executer: () => Promise<unknown>,
): Promise<CallToolResult> {
  if (dryRun) return json({ dry_run: true, ...recap });
  try {
    return json({ ok: true, ...recap, resultat: resumeReponse(await executer()) });
  } catch (e) {
    return json({ ok: false, ...recap, erreur: messageErreur(e) });
  }
}

/** Garde les champs renseignés. */
export function champs(map: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
}
