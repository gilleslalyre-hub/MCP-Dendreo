import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DendreoClient } from "./dendreo/client.js";
import { registerCatalogueTools } from "./tools/catalogue.js";
import { registerCreationTools } from "./tools/creation.js";
import { registerCrmNettoyageTools, registerCrmTools } from "./tools/crm.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerExportTools } from "./tools/exports.js";
import { registerFinanceTools } from "./tools/finance.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerGestionTools } from "./tools/gestion.js";
import { registerInscriptionTools } from "./tools/inscriptions.js";
import { registerLectureTools } from "./tools/lecture.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerQualiteTools } from "./tools/qualite.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerSuiviTools } from "./tools/suivi.js";
import { registerSyntheseTools } from "./tools/synthese.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "dendreo", version: "0.4.0" },
    {
      instructions:
        "Dendreo (formation). Outils d'écriture : dry_run=true par défaut (rien n'est écrit) ; ne relancer avec dry_run=false qu'après confirmation explicite de l'utilisateur. Ids : numéro complet (ADF_…, ENT_…, MOD_…) ou id numérique, ou nom quand l'outil le permet. Dates AAAA-MM-JJ. Réponses en JSON compact.",
    },
  );
  const client = DendreoClient.fromEnv();
  registerSessionTools(server, client);
  registerLectureTools(server, client);
  registerCreationTools(server, client);
  registerInscriptionTools(server, client);
  registerPlanningTools(server, client);
  registerSuiviTools(server, client);
  registerGestionTools(server, client);
  registerCrmTools(server, client);
  registerCrmNettoyageTools(server, client);
  registerDocumentTools(server, client);
  registerSyntheseTools(server, client);
  registerExportTools(server, client);
  registerFinanceTools(server, client);
  registerQualiteTools(server, client);
  registerCatalogueTools(server, client);
  registerGenericTools(server, client);
  return server;
}
