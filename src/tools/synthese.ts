import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { resumeEmail } from "./documents.js";
import { findSession, inscriptionsSession, single } from "./resolve.js";
import { statut } from "./suivi.js";
import { DATE, json, nomDe, splitDateTime, today, vrai } from "./util.js";

const nomLap = (l: Row | undefined) => nomDe(l?.participant) ?? "Participant non identifié";

/** Tâches extranet en attente des participants d'une session, regroupées par participant. */
async function tachesSession(client: DendreoClient, idAdf: string, laps: Row[]) {
  const ids = laps.map((l) => String(l.id_participant)).filter((id) => id !== "0");
  if (ids.length === 0) return [];
  const noms = new Map(laps.map((l) => [String(l.id_participant), nomLap(l)]));
  return (await client.list("taches.php", { id: ids.join(",") }))
    .map((r) => ({
      participant: noms.get(String(r.id_participant)) ?? String(r.id_participant),
      email: ((laps.find((l) => String(l.id_participant) === String(r.id_participant))?.participant ?? {}) as Row).email,
      taches: ((r.taches ?? []) as Row[]).filter((t) => String(t.id_adf) === idAdf),
    }))
    .filter((p) => p.taches.length > 0);
}

export function registerSyntheseTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "tableau_de_bord_session",
    {
      description:
        "Synthèse d'une action de formation en un appel : remplissage et places, étape, staffing des créneaux, " +
        "assiduité et présences manquantes, émargements et questionnaires en attente, emails non délivrés, " +
        "avancement des checklists, et la liste des points d'attention.",
      inputSchema: { session: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const s = single(await findSession(client, args.session), "Session");
      if (!("row" in s)) return json(s);
      const adf = s.row;
      const idAdf = String(adf.id_action_de_formation);
      const [laps, creneaux, lcps, lcfs, emails, checklists, etapes] = await Promise.all([
        inscriptionsSession(client, idAdf),
        client.list("creneaux.php", { id_action_de_formation: idAdf, include: "formateurs" }),
        client.list("lcps.php", { id_action_de_formation: idAdf }),
        client.list("lcfs.php", { id_action_de_formation: idAdf }),
        client.list("emails.php", { id_action_de_formation: idAdf }),
        client.list("checklists.php", { cible: "action_de_formation", id_cible: idAdf }),
        client.list("etapes.php"),
      ]);
      const taches = await tachesSession(client, idAdf, laps);
      const maintenant = `${today()} 23:59:59`;
      const attention: string[] = [];

      const inscrits = Number(adf.nb_participants_inscrits ?? laps.length);
      const min = Number(adf.nb_participants_min ?? 0);
      const max = Number(adf.nb_participants_max ?? 0);
      if (min > 0 && inscrits < min) attention.push(`Sous le minimum : ${inscrits} inscrit(s) pour ${min} requis.`);
      if (max > 0 && inscrits > max) attention.push(`Sureffectif : ${inscrits} inscrits pour ${max} places.`);

      const staffes = new Set(lcfs.filter((l) => vrai(l.status)).map((l) => String(l.id_creneau)));
      const sansFormateur = creneaux.filter(
        (c) => !staffes.has(String(c.id_creneau)) && !((c.formateurs ?? []) as Row[]).length,
      );
      if (sansFormateur.length) attention.push(`${sansFormateur.length} créneau(x) sans formateur.`);

      const passes = new Set(creneaux.filter((c) => String(c.date_fin) <= maintenant).map((c) => String(c.id_creneau)));
      const lcpsPasses = lcps.filter((p) => passes.has(String(p.id_creneau)));
      const heures = (k: string) => lcpsPasses.reduce((acc, p) => acc + Number(p[k] ?? 0), 0);
      const hp = heures("total_heures_presence");
      const ha = heures("total_heures_absence");
      const nonRenseignes = lcpsPasses.filter((p) => statut(p) === "non_renseigne").length;
      const absNonJustifiees = lcpsPasses.filter((p) => statut(p) === "absent_non_justifie").length;
      if (nonRenseignes) attention.push(`${nonRenseignes} présence(s) non renseignée(s) sur des créneaux passés.`);
      if (absNonJustifiees) attention.push(`${absNonJustifiees} absence(s) non justifiée(s).`);

      const compte = (type: string) => taches.reduce((acc, p) => acc + p.taches.filter((t) => t.type === type).length, 0);
      const tachesParType = {
        emargements: compte("esignature"),
        documents_a_signer: compte("esignature-doc"),
        questionnaires_satisfaction: compte("satisfaction"),
        auto_positionnement: compte("auto-positionnement"),
      };
      if (tachesParType.emargements) attention.push(`${tachesParType.emargements} émargement(s) électronique(s) en attente.`);
      if (tachesParType.documents_a_signer) attention.push(`${tachesParType.documents_a_signer} document(s) à signer.`);

      const emailsEchec = emails.map(resumeEmail).filter((e) => e.en_echec);
      if (emailsEchec.length) attention.push(`${emailsEchec.length} email(s) non délivré(s) à au moins un destinataire.`);

      const checklistsOuvertes = checklists.filter((c) => Number(c.checks_done) < Number(c.checks_total));
      if (checklistsOuvertes.length) {
        attention.push(
          `Checklist incomplète : ${checklistsOuvertes.map((c) => `${c.checks_done}/${c.checks_total}`).join(", ")}.`,
        );
      }

      const etape = etapes.find((e) => String(e.id_etape_process) === String(adf.id_etape_process));
      const tri = [...creneaux].sort((a, b) => String(a.date_debut).localeCompare(String(b.date_debut)));
      const prochain = tri.find((c) => String(c.date_debut) > `${today()} 00:00:00`);
      return json({
        session: `${adf.numero_complet} — ${adf.intitule}`,
        type: adf.type,
        etape: etape?.intitule ?? adf.id_etape_process,
        dates: { du: String(adf.date_debut).slice(0, 10), au: String(adf.date_fin).slice(0, 10) },
        prochain_creneau: prochain ? `${splitDateTime(prochain.date_debut).date} ${splitDateTime(prochain.date_debut).heure}` : undefined,
        remplissage: { inscrits, places_min: min || undefined, places_max: max || undefined, en_attente: adf.nb_participants_en_attente },
        planning: { creneaux: creneaux.length, passes: passes.size, sans_formateur: sansFormateur.length },
        assiduite: {
          taux: hp + ha > 0 ? `${Math.round((hp / (hp + ha)) * 100)} %` : undefined,
          heures_presence: hp,
          heures_absence: ha,
          presences_non_renseignees: nonRenseignes,
          absences_non_justifiees: absNonJustifiees,
        },
        taches_en_attente: tachesParType,
        emails: { envoyes: emails.length, en_echec: emailsEchec.map((e) => ({ sujet: e.sujet, date: e.date, destinataires: e.destinataires.filter((d) => d.statut !== "delivered") })) },
        checklists: checklists.map((c) => `${c.checks_done}/${c.checks_total}${c.remarque ? ` (${c.remarque})` : ""}`),
        points_d_attention: attention.length ? attention : ["Rien à signaler."],
      });
    },
  );

  server.registerTool(
    "relances_a_faire",
    {
      description:
        "Sur une période (par défaut les 30 derniers jours), liste par session les participants à relancer : émargement " +
        "électronique ou document à signer en attente, questionnaire de satisfaction ou d'auto-positionnement non rempli, " +
        "email non délivré. Donne l'email du participant et les liens à transmettre.",
      inputSchema: {
        du: DATE.optional().describe("Début de la période (sessions ayant un créneau dans la période)"),
        au: DATE.optional().describe("Fin de la période (défaut aujourd'hui)"),
        types: z
          .array(z.enum(["esignature", "esignature-doc", "satisfaction", "auto-positionnement", "email"]))
          .optional()
          .describe("Limiter à ces motifs de relance"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const au = args.au ?? today();
      const du = args.du ?? new Date(Date.parse(`${au}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
      const garder = (t: string) => !args.types || args.types.includes(t as never);
      const creneaux = await client.list("creneaux.php", { started_after: du, started_before: `${au} 23:59:59` });
      const ids = [...new Set(creneaux.map((c) => String(c.id_action_de_formation)))];
      const adfs = ids.length
        ? await client.list("actions_de_formation.php", { id: ids.join(","), fields: "id_action_de_formation,numero_complet,intitule" })
        : [];

      const sessions = [];
      for (const adf of adfs) {
        const idAdf = String(adf.id_action_de_formation);
        const laps = await inscriptionsSession(client, idAdf);
        const [taches, emails] = await Promise.all([
          tachesSession(client, idAdf, laps),
          garder("email") ? client.list("emails.php", { id_action_de_formation: idAdf }) : Promise.resolve([]),
        ]);
        const relances = taches
          .map((p) => ({
            participant: p.participant,
            email: p.email || undefined,
            motifs: p.taches
              .filter((t) => garder(String(t.type)))
              .map((t) => ({
                motif: t.type === "esignature"
                  ? `émargement du ${t.creneau_date_debut}`
                  : t.type === "esignature-doc"
                    ? "document à signer"
                    : `${t.type === "satisfaction" ? "questionnaire de satisfaction" : "auto-positionnement"} ${t.questionnaire_type ?? t.positionnement_type ?? ""}`.trim(),
                lien: t.url,
              })),
          }))
          .filter((p) => p.motifs.length > 0);
        const nonDelivres = emails
          .map(resumeEmail)
          .flatMap((e) =>
            e.destinataires
              .filter((d) => ["non envoyé", "dropped", "bounced", "complained"].includes(String(d.statut)))
              .map((d) => ({ destinataire: d.email, sujet: e.sujet, date: e.date, statut: d.statut, erreur: d.erreur })),
          );
        if (relances.length || nonDelivres.length) {
          sessions.push({
            session: `${adf.numero_complet} — ${adf.intitule}`,
            ...(relances.length ? { participants: relances } : {}),
            ...(nonDelivres.length ? { emails_non_delivres: nonDelivres } : {}),
          });
        }
      }
      return json({ periode: { du, au }, nb_sessions: sessions.length, sessions });
    },
  );
}
