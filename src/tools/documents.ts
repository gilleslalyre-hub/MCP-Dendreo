import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DendreoClient, Query, Row } from "../dendreo/client.js";
import { findEntreprise, findFormateur, findInscription, findModule, findSession, inscriptionsSession, single } from "./resolve.js";
import { json, nomDe, vrai } from "./util.js";

const SESSION = z.string().describe("Id de l'action de formation ou numéro complet (ADF_…)");
const sessionLabel = (adf: Row) => `${adf.numero_complet} — ${adf.intitule}`;
const nomLap = (l: Row) => nomDe(l.participant) ?? `participant ${l.id_participant}`;

/** Au-delà, on renvoie seulement la liste des documents générés, pas leur contenu. */
const MAX_DOCUMENTS = 3;
/** Taille max (Ko) d'un document joint en base64 ; au-delà, seuls son nom et sa taille sont renvoyés. */
const MAX_KO_JOINT = 300;

/** Résumé d'un email envoyé, avec le statut de chaque destinataire. */
export function resumeEmail(m: Row) {
  const destinataires = ((m.destinataires ?? []) as Row[]).map((d) => ({
    email: d.email,
    type: d.type_destinataire,
    statut: String(m.http_response_code) !== "200" ? "non envoyé" : d.event || "en cours",
    erreur: [d.reason, d.description, d.error].filter(Boolean).join(" — ") || undefined,
  }));
  return {
    id_mail: m.id_mail,
    date: m.date_add,
    sujet: m.title,
    id_action_de_formation: String(m.id_action_de_formation) !== "0" ? m.id_action_de_formation : undefined,
    erreur_envoi: m.http_error_msg || undefined,
    destinataires,
    en_echec: destinataires.some((d) => ["non envoyé", "dropped", "bounced", "complained"].includes(String(d.statut))),
  };
}

export function registerDocumentTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "generer_document",
    {
      title: "Générer un document",
      description:
        "Génère un document à partir d'un modèle Dendreo (convocation, convention, attestation, certificat de " +
        "réalisation, programme…) et renvoie le fichier. Le modèle se désigne par son id (`modele`, visible dans " +
        "Dendreo > Paramètres > Modèles de documents). Contexte : une session seule, une session + un participant, " +
        "une entreprise, un formateur ou un module, une session + participant + module (document module × participant), " +
        "une facture ou un devis, ou hors session une fiche participant/entreprise/formateur/module. " +
        "`tous_les_participants=true` génère le document pour chaque inscrit de la session.",
      inputSchema: {
        modele: z.string().describe("Id du modèle de document (id_doc_type)"),
        session: SESSION.optional(),
        participant: z.string().optional().describe("Prénom et nom, email ou id (inscrit à la session si session fournie)"),
        tous_les_participants: z.boolean().default(false),
        entreprise: z.string().optional().describe("Raison sociale, ENT_… ou id"),
        formateur: z.string().optional().describe("Prénom et nom, ou id"),
        module: z.string().optional().describe("Intitulé, MOD_… ou id (avec session + participant : document module × participant)"),
        facture: z.string().optional().describe("Numéro complet (FA_…) ou id d'une facture"),
        devis: z.string().optional().describe("Id d'un devis"),
        format: z.enum(["pdf", "word"]).default("pdf"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const base: Query = { id_doc_type: args.modele, generate: 1, pdf: args.format === "pdf" ? 1 : 0 };
      const demandes: { libelle: string; query: Query }[] = [];

      if (args.facture) {
        const rows = /^\d+$/.test(args.facture)
          ? await client.list("factures.php", { id: args.facture })
          : await client.list("factures.php", { numero_complet: args.facture });
        const f = single(rows, "Facture");
        if (!("row" in f)) return json(f);
        demandes.push({ libelle: String(f.row.numero_complet), query: { m: "facture", ...base, id_facture: String(f.row.id_facture) } });
      } else if (args.devis) {
        demandes.push({ libelle: `devis ${args.devis}`, query: { m: "devis", ...base, id_devis: args.devis } });
      } else if (args.session) {
        const s = single(await findSession(client, args.session), "Session");
        if (!("row" in s)) return json(s);
        const idAdf = String(s.row.id_action_de_formation);
        const ctx = { ...base, id_adf: idAdf };
        if (args.participant && args.module) {
          const laps = await inscriptionsSession(client, idAdf);
          const cibles = findInscription(laps, args.participant);
          if (cibles.length !== 1) return json({ erreur: cibles.length ? "Participant ambigu." : "Participant non inscrit à cette session." });
          const mods = new Set((await findModule(client, args.module)).map((m) => String(m.id_module)));
          const lam = (await client.list("lams.php", { id_action_de_formation: idAdf })).find((l) => mods.has(String(l.id_module)));
          if (!lam) return json({ erreur: "Ce module n'est pas programmé dans la session." });
          const lmp = (await client.list("lmps.php", { id_action_de_formation: idAdf })).find(
            (l) => String(l.id_lam) === String(lam.id_lam) && String(l.id_lap) === String(cibles[0].id_lap),
          );
          if (!lmp) return json({ erreur: "Ce participant n'est pas inscrit à ce module." });
          demandes.push({ libelle: `${nomLap(cibles[0])} × ${lam.intitule ?? lam.id_module}`, query: { m: "adf_module_participant", ...ctx, id_lmp: String(lmp.id_lmp) } });
        } else if (args.participant || args.tous_les_participants) {
          const laps = await inscriptionsSession(client, idAdf);
          const cibles = args.tous_les_participants
            ? laps.filter((l) => String(l.id_participant) !== "0")
            : findInscription(laps, args.participant!);
          if (!args.tous_les_participants && cibles.length !== 1) {
            return json({ erreur: cibles.length ? "Participant ambigu." : "Participant non inscrit à cette session.", inscrits: laps.map(nomLap) });
          }
          for (const l of cibles) demandes.push({ libelle: nomLap(l), query: { m: "adf_participant", ...ctx, id_lap: String(l.id_lap) } });
        } else if (args.entreprise) {
          const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
          if (!("row" in e)) return json(e);
          const lae = (await client.list("laes.php", { id_action_de_formation: idAdf })).find(
            (l) => String(l.id_entreprise) === String(e.row.id_entreprise),
          );
          if (!lae) return json({ erreur: "Cette entreprise n'est pas rattachée à la session." });
          demandes.push({ libelle: String(e.row.raison_sociale), query: { m: "adf_entreprise", ...ctx, id_lae: String(lae.id_lae) } });
        } else if (args.formateur) {
          const f = single(await findFormateur(client, args.formateur), "Formateur");
          if (!("row" in f)) return json(f);
          const laf = (await client.list("lafs.php", { id_action_de_formation: idAdf })).find(
            (l) => String(l.id_formateur) === String(f.row.id_formateur),
          );
          if (!laf) return json({ erreur: "Ce formateur n'est pas staffé sur la session." });
          demandes.push({ libelle: `${f.row.prenom} ${f.row.nom}`, query: { m: "adf_formateur", ...ctx, id_laf: String(laf.id_laf) } });
        } else if (args.module) {
          const mods = new Set((await findModule(client, args.module)).map((m) => String(m.id_module)));
          const lam = (await client.list("lams.php", { id_action_de_formation: idAdf })).find((l) => mods.has(String(l.id_module)));
          if (!lam) return json({ erreur: "Ce module n'est pas programmé dans la session." });
          demandes.push({ libelle: String(lam.intitule ?? lam.id_module), query: { m: "adf_module", ...ctx, id_lam: String(lam.id_lam) } });
        } else {
          demandes.push({ libelle: sessionLabel(s.row), query: { m: "adf", ...ctx } });
        }
      } else if (args.participant) {
        demandes.push({ libelle: `participant ${args.participant}`, query: { m: "participant", ...base, id_participant: args.participant } });
      } else if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        demandes.push({ libelle: String(e.row.raison_sociale), query: { m: "entreprise", ...base, id_entreprise: String(e.row.id_entreprise) } });
      } else if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        demandes.push({ libelle: `${f.row.prenom} ${f.row.nom}`, query: { m: "formateur", ...base, id_formateur: String(f.row.id_formateur) } });
      } else if (args.module) {
        const m = single(await findModule(client, args.module), "Module");
        if (!("row" in m)) return json(m);
        demandes.push({ libelle: String(m.row.intitule), query: { m: "module", ...base, id_module: String(m.row.id_module) } });
      } else {
        return json({ erreur: "Préciser le contexte : session, participant, entreprise, formateur ou module." });
      }
      if (demandes.length === 0) return json({ erreur: "Aucun participant identifié dans cette session." });

      const result: CallToolResult = { content: [] };
      const journal: string[] = [];
      for (const [i, d] of demandes.entries()) {
        try {
          const doc = await client.download("documents.php", d.query);
          const nom = doc.nom ?? `${d.libelle}.${args.format === "pdf" ? "pdf" : "docx"}`;
          journal.push(`${d.libelle} : ${nom} (${Math.round(doc.contenu.length / 1024)} Ko)`);
          if (i < MAX_DOCUMENTS && doc.contenu.length <= MAX_KO_JOINT * 1024) {
            result.content.push({
              type: "resource",
              resource: { uri: `dendreo://documents/${encodeURIComponent(nom)}`, mimeType: doc.type, blob: doc.contenu.toString("base64") },
            });
          }
        } catch (e) {
          journal.push(`${d.libelle} : erreur : ${(e as Error).message}`);
        }
      }
      if (demandes.length > MAX_DOCUMENTS) journal.push(`Seuls les ${MAX_DOCUMENTS} premiers documents sont joints (et ≤ ${MAX_KO_JOINT} Ko) : relancer par participant pour les autres.`);
      result.content.unshift({ type: "text", text: JSON.stringify({ documents: journal }) });
      return result;
    },
  );

  server.registerTool(
    "fichiers",
    {
      title: "Fichiers d'une session ou d'une fiche",
      description:
        "Gère les fichiers stockés dans Dendreo : `lister` ceux d'une session, d'un participant, d'une entreprise, d'un " +
        "formateur ou d'un module (espace de stockage par défaut, ou une collection : partage_adf_participants, " +
        "partage_participant, fichiers_lies_adf…) ; `deposer` un fichier (contenu en base64) ; `supprimer` des fichiers. " +
        "Dépôt et suppression en dry_run=true par défaut.",
      inputSchema: {
        action: z.enum(["lister", "deposer", "supprimer"]).default("lister"),
        cible: z.enum(["action-de-formation", "participant", "entreprise", "formateur", "module", "contact", "lap", "laf", "lae", "salle"]).optional().describe("Sans cible, un dépôt part sans rattachement (tri automatique par QR code de Dendreo)"),
        id_cible: z.string().optional().describe("Id de la fiche, ou de la session (id ou ADF_…) si cible=action-de-formation"),
        collection: z.string().optional().describe("Collection Dendreo, par défaut l'espace de stockage (docssaved). Autres : partage_adf_participants / _formateurs / _entreprises, partage_lap, partage_laf, partage_lae, partage_salle_public, partage_module_public, partage_module_formateurs, visuel, signature"),
        nom_fichier: z.string().optional().describe("Pour deposer : nom du fichier avec extension"),
        contenu_base64: z.string().optional().describe("Pour deposer : contenu du fichier encodé en base64"),
        dossier: z.string().optional().describe("Pour deposer sur une session : sous-dossier de l'espace de stockage"),
        entite_liee_type: z.enum(["entreprise", "participant", "formateur", "module"]).optional().describe("Pour deposer sur une session : lie le fichier à cet élément de la session"),
        entite_liee_id: z.string().optional().describe("Id de l'élément lié (avec entite_liee_type)"),
        ids: z.array(z.string()).optional().describe("Pour supprimer : ids des fichiers"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      if (args.action === "supprimer") {
        if (!args.ids?.length) return json({ erreur: "Préciser les ids des fichiers à supprimer." });
        const fichiers = await client.list("fichiers.php", { id: args.ids.join(",") });
        const recap = { a_supprimer: fichiers.map((f) => ({ id: f.id, nom: f.name, cible: `${f.cible} ${f.id_cible}` })) };
        if (args.dry_run) return json({ dry_run: true, ...recap });
        await client.delete("fichiers.php", { id: args.ids.join(",") });
        return json({ ok: true, ...recap });
      }
      if (args.action === "deposer" && !args.cible && !args.id_cible) {
        if (!args.nom_fichier || !args.contenu_base64) return json({ erreur: "Préciser nom_fichier et contenu_base64." });
        const contenu = Buffer.from(args.contenu_base64, "base64");
        const recap = { fichier: args.nom_fichier, taille_ko: Math.round(contenu.length / 1024), rattachement: "aucun (tri automatique par QR code)" };
        if (args.dry_run) return json({ dry_run: true, ...recap });
        return json({ ok: true, ...recap, resultat: await client.postFile("fichiers.php", {}, { nom: args.nom_fichier, contenu }) });
      }
      if (!args.cible || !args.id_cible) return json({ erreur: "Préciser cible et id_cible." });
      let idCible = args.id_cible;
      if (args.cible === "action-de-formation") {
        const s = single(await findSession(client, args.id_cible, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        idCible = String(s.row.id_action_de_formation);
      }
      if (args.action === "lister") {
        const rows = await client.list("fichiers.php", { cible: args.cible, id_cible: idCible, collection_name: args.collection });
        return json({
          nombre: rows.length,
          fichiers: rows.map((f) => ({
            id: f.id,
            nom: f.name,
            type: f.mime_type,
            taille_ko: f.size ? Math.round(Number(f.size) / 1024) : undefined,
            collection: f.collection_name,
            ajoute_le: f.created_at,
            url: f.public_url || undefined,
          })),
        });
      }
      if (!args.nom_fichier || !args.contenu_base64) return json({ erreur: "Préciser nom_fichier et contenu_base64." });
      const contenu = Buffer.from(args.contenu_base64, "base64");
      const champs = {
        cible: args.cible,
        id_cible: idCible,
        collection: args.collection ?? "docssaved",
        chemin: args.dossier,
        entite_liee_type: args.entite_liee_type,
        entite_liee_id: args.entite_liee_id,
      };
      const recap = { fichier: args.nom_fichier, taille_ko: Math.round(contenu.length / 1024), ...champs };
      if (args.dry_run) return json({ dry_run: true, ...recap });
      return json({ ok: true, ...recap, resultat: await client.postFile("fichiers.php", champs, { nom: args.nom_fichier, contenu }) });
    },
  );

  server.registerTool(
    "suivi_emails",
    {
      title: "Suivi des emails envoyés",
      description:
        "Emails envoyés par Dendreo (convocations, relances…) pour une session ou un destinataire, avec le statut de " +
        "chaque destinataire : délivré, rejeté (bounced/dropped), signalé en spam, en cours. `echecs_seulement=true` " +
        "ne garde que les emails non arrivés. L'API ne permet pas d'envoyer d'email : l'envoi se fait dans Dendreo.",
      inputSchema: {
        session: SESSION.optional(),
        destinataire: z.string().optional().describe("Adresse email du destinataire"),
        echecs_seulement: z.boolean().default(false),
        evenement: z.enum(["delivered", "dropped", "bounced", "complained"]).optional().describe("Filtrer sur le statut d'un destinataire"),
        du: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Emails envoyés à partir de cette date"),
        au: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Emails envoyés jusqu'à cette date"),
        decalage: z.number().int().min(0).default(0).describe("Pagination : l'API renvoie 100 emails à partir de ce rang"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let idAdf: string | undefined;
      let label: string | undefined;
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        idAdf = String(s.row.id_action_de_formation);
        label = sessionLabel(s.row);
      }
      const rows = await client.list("emails.php", { id_action_de_formation: idAdf, to_email: args.destinataire, event: args.evenement, offset: args.decalage || undefined });
      let emails = rows.map(resumeEmail).filter((e) => (!args.du || String(e.date).slice(0, 10) >= args.du) && (!args.au || String(e.date).slice(0, 10) <= args.au));
      if (args.echecs_seulement) emails = emails.filter((e) => e.en_echec);
      return json({ session: label, page: rows.length >= 100 ? `100 emails lus à partir du rang ${args.decalage} : relancer avec decalage=${args.decalage + 100} pour la suite` : undefined, nombre: emails.length, en_echec: emails.filter((e) => e.en_echec).length, emails });
    },
  );

  server.registerTool(
    "checklist",
    {
      title: "Checklist administrative",
      description:
        "Affiche l'avancement des checklists d'une session (ou d'un formateur, d'un module) et permet de cocher ou " +
        "décocher, ajouter, renommer ou supprimer des points ; `portefeuille=true` liste les sessions INTER dont la " +
        "checklist est incomplète. Modifications en dry_run=true par défaut.",
      inputSchema: {
        session: SESSION.optional(),
        cible: z.enum(["formateur", "module", "lap", "laf"]).optional().describe("Autre cible que la session"),
        id_cible: z.string().optional(),
        cocher: z.array(z.string()).optional().describe("Points à cocher (id_check ou intitulé)"),
        decocher: z.array(z.string()).optional().describe("Points à décocher (id_check ou intitulé)"),
        ajouter: z.array(z.string()).optional().describe("Nouveaux points à ajouter"),
        supprimer: z.array(z.string()).optional().describe("Points à supprimer (id_check ou intitulé)"),
        renommer: z.array(z.object({ point: z.string().describe("id_check ou intitulé actuel"), intitule: z.string() })).optional(),
        portefeuille: z.boolean().default(false).describe("Vue d'ensemble : sessions INTER dont la checklist est incomplète"),
        id_checklist: z.string().optional().describe("Checklist où ajouter, si la cible en a plusieurs"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      if (args.portefeuille) {
        const rows = await client.list("checklists.php", { cible: "action_de_formation_inter" });
        const incompletes = rows
          .filter((c) => Number(c.checks_done ?? 0) < Number(c.checks_total ?? 0))
          .map((c) => ({ id_cible: c.id_cible, id_checklist: c.id_checklist, remarque: c.remarque || undefined, avancement: `${c.checks_done}/${c.checks_total}`, restant: ((c.checks ?? []) as Row[]).filter((k) => !vrai(k.done)).map((k) => k.intitule) }));
        return json({ checklists_incompletes: incompletes.length, sur: rows.length, incompletes });
      }
      let query: Query;
      let label: string;
      if (args.session) {
        const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
        if (!("row" in s)) return json(s);
        query = { cible: "action_de_formation", id_cible: String(s.row.id_action_de_formation) };
        label = sessionLabel(s.row);
      } else if (args.cible && args.id_cible) {
        query = { cible: args.cible, id_cible: args.id_cible };
        label = `${args.cible} ${args.id_cible}`;
      } else {
        return json({ erreur: "Préciser une session, ou cible et id_cible." });
      }
      const checklists = await client.list("checklists.php", query);
      const checks: Row[] = checklists.flatMap((c) => ((c.checks ?? []) as Row[]).map((k) => ({ ...k, id_checklist: c.id_checklist })));
      const trouver = (q: string) => checks.filter((k) => String(k.id_check) === q || String(k.intitule).toLowerCase().includes(q.toLowerCase()));

      const ops: { quoi: string; body: Row; suppression?: boolean }[] = [];
      const inconnus: string[] = [];
      for (const [liste, done] of [[args.cocher, 1], [args.decocher, 0]] as const) {
        for (const q of liste ?? []) {
          const found = trouver(q);
          if (found.length !== 1) inconnus.push(`${q} (${found.length ? "ambigu" : "introuvable"})`);
          else if (vrai(found[0].done) !== (done === 1)) {
            ops.push({ quoi: `${done ? "cocher" : "décocher"} « ${found[0].intitule} »`, body: { id_check: found[0].id_check, done } });
          }
        }
      }
      for (const q of args.supprimer ?? []) {
        const found = trouver(q);
        if (found.length !== 1) inconnus.push(`${q} (${found.length ? "ambigu" : "introuvable"})`);
        else ops.push({ quoi: `supprimer « ${found[0].intitule} »`, body: { id_check: found[0].id_check }, suppression: true });
      }
      for (const r of args.renommer ?? []) {
        const found = trouver(r.point);
        if (found.length !== 1) inconnus.push(`${r.point} (${found.length ? "ambigu" : "introuvable"})`);
        else ops.push({ quoi: `renommer « ${found[0].intitule} » en « ${r.intitule} »`, body: { id_check: found[0].id_check, intitule: r.intitule } });
      }
      if (args.ajouter?.length) {
        const idChecklist = args.id_checklist ?? (checklists.length === 1 ? checklists[0].id_checklist : undefined);
        if (!idChecklist) {
          return json({ erreur: "Préciser id_checklist pour ajouter des points.", checklists: checklists.map((c) => ({ id_checklist: c.id_checklist, remarque: c.remarque })) });
        }
        for (const intitule of args.ajouter) ops.push({ quoi: `ajouter « ${intitule} »`, body: { id_checklist: idChecklist, intitule } });
      }

      const etat = {
        cible: label,
        checklists: checklists.map((c) => ({
          id_checklist: c.id_checklist,
          remarque: c.remarque || undefined,
          avancement: `${c.checks_done}/${c.checks_total}`,
          points: ((c.checks ?? []) as Row[]).map((k) => ({ id_check: k.id_check, intitule: k.intitule, fait: vrai(k.done) })),
        })),
        ...(ops.length ? { changements: ops.map((o) => o.quoi) } : {}),
        ...(inconnus.length ? { introuvables: inconnus } : {}),
      };
      if (ops.length === 0 || args.dry_run) return json({ ...(ops.length ? { dry_run: true } : {}), ...etat });
      const journal: string[] = [];
      for (const o of ops) {
        try {
          if (o.suppression) await client.delete("checks.php", { id_check: String(o.body.id_check) });
          else await client.post("checks.php", o.body);
          journal.push(`${o.quoi} : ok`);
        } catch (e) {
          journal.push(`${o.quoi} : erreur : ${(e as Error).message}`);
        }
      }
      return json({ ...etat, journal });
    },
  );
}
