import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DendreoClient, Row } from "../dendreo/client.js";
import { appliquer, champs } from "./ecriture.js";
import { findEntreprise, findFormateur, findModule, findSalle, findSession, single } from "./resolve.js";
import { DATE, arrondi, heuresCreneau, json, nomDe, normalize, num, vrai } from "./util.js";

const SESSION = z.string();

export function registerCatalogueTools(server: McpServer, client: DendreoClient) {
  server.registerTool(
    "enregistrer_module",
    {
      description:
        "Crée (`intitule` obligatoire) ou modifie le module `module` (intitulé, MOD_… ou id) du catalogue, ou le supprime " +
        "(refusé s'il est programmé dans des sessions). Planning type : `jours` seul, ou + `duree_par_jour` (heures), ou + " +
        "`creneaux` d'une journée (ex. 08:30-11:00;14:30-16:50). `formateurs_aptes` : prénom nom ou id ; `catalogue` : " +
        "visible sur le catalogue public.",
      inputSchema: {
        module: z.string().optional(),
        supprimer: z.boolean().default(false),
        intitule: z.string().optional(),
        intitule_court: z.string().optional(),
        description: z.string().optional(),
        objectif: z.string().optional(),
        public_vise: z.string().optional(),
        pre_requis: z.string().optional(),
        modalites_pedagogiques: z.string().optional(),
        modalites_devaluation: z.string().optional(),
        moyens_supports_pedagogiques: z.string().optional(),
        accessibilite: z.string().optional(),
        prix_inter: z.number().optional(),
        prix_intra: z.number().optional(),
        duree_heures: z.number().optional(),
        jours: z.number().int().optional(),
        duree_par_jour: z.number().optional(),
        creneaux: z.string().optional(),
        places_min: z.number().int().optional(),
        places_max: z.number().int().optional(),
        categorie: z.string().optional().describe("Intitulé ou id"),
        formateurs_aptes: z.array(z.string()).optional(),
        mode_organisation: z.enum(["presentiel", "elearning_sync", "mixte", "elearning_async", "stage"]).optional(),
        catalogue: z.boolean().optional(),
        eligible_cpf: z.boolean().optional(),
        eligible_dpc: z.boolean().optional(),
        include_in_bpf: z.boolean().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      let existant: Row | undefined;
      if (args.module) {
        const m = single(await findModule(client, args.module), "Module");
        if (!("row" in m)) return json(m);
        [existant] = await client.list("modules.php", { id: String(m.row.id_module) });
      }
      if (args.supprimer) {
        if (!existant) return json({ erreur: "Préciser le module à supprimer." });
        const lams = await client.list("lams.php", { id_module: String(existant.id_module) });
        if (lams.length > 0) return json({ erreur: `Module programmé dans ${lams.length} session(s) : suppression refusée.` });
        return appliquer(args.dry_run, { action: "suppression", module: `${existant.numero_complet} — ${existant.intitule}` }, () =>
          client.delete("modules.php", { id: String(existant!.id_module) }),
        );
      }
      if (!existant && !args.intitule) return json({ erreur: "intitule requis pour créer un module." });
      const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
      let idCategorie: string | undefined;
      if (args.categorie) {
        const cats = await client.list("categories_module.php");
        const c = /^\d+$/.test(args.categorie) ? cats.filter((x) => String(x.id_categorie_module) === args.categorie) : cats.filter((x) => normalize(x.intitule) === normalize(args.categorie));
        if (c.length !== 1) return json({ erreur: c.length ? "Catégorie ambiguë." : `Catégorie « ${args.categorie} » introuvable : la créer avec categories_modules.`, categories: cats.map((x) => x.intitule) });
        idCategorie = String(c[0].id_categorie_module);
      }
      let formateurs: string | undefined;
      if (args.formateurs_aptes) {
        const ids: string[] = [];
        for (const f of args.formateurs_aptes) {
          const r = single(await findFormateur(client, f), `Formateur « ${f} »`);
          if (!("row" in r)) return json(r);
          ids.push(String(r.row.id_formateur));
        }
        formateurs = ids.join(",");
      }
      const body = champs({
        intitule: args.intitule, intitule_court: args.intitule_court, description: args.description, objectif: args.objectif,
        public_vise: args.public_vise, pre_requis: args.pre_requis, modalites_pedagogiques: args.modalites_pedagogiques,
        modalites_devaluation: args.modalites_devaluation, moyens_supports_pedagogiques: args.moyens_supports_pedagogiques,
        accessibilite: args.accessibilite, prix: args.prix_inter, prix_intra: args.prix_intra, duree_heures: args.duree_heures,
        import_jours: args.jours, import_duree: args.duree_par_jour, import_creneaux: args.creneaux,
        nb_participants_min: args.places_min, nb_participants: args.places_max, id_categorie_module: idCategorie, formateurs,
        mode_organisation: args.mode_organisation, catalogue: flag(args.catalogue), eligible_cpf: flag(args.eligible_cpf),
        eligible_dpc: flag(args.eligible_dpc), include_in_bpf: flag(args.include_in_bpf),
      });
      if (Object.keys(body).length === 0) return json({ erreur: "Aucune valeur à enregistrer." });
      const doublons = !existant && args.intitule ? (await client.list("modules.php", { intitule: args.intitule, fields: "id_module,intitule,numero_complet" })).filter((m) => normalize(m.intitule) === normalize(args.intitule)) : [];
      if (doublons.length) return json({ erreur: "Un module de même intitulé existe déjà : le modifier plutôt que le recréer.", doublons });
      const recap = {
        action: existant ? "modification" : "creation",
        module: existant ? `${existant.numero_complet} — ${existant.intitule}` : args.intitule,
        ...(existant ? { avant: Object.fromEntries(Object.keys(body).filter((k) => k in existant!).map((k) => [k, existant![k]])) } : {}),
        valeurs: body,
      };
      return appliquer(args.dry_run, recap, () => client.post("modules.php", existant ? { id: existant.id_module, ...body } : body));
    },
  );

  server.registerTool(
    "categories_modules",
    {
      description:
        "Arborescence des catégories de modules du catalogue, et modules sans catégorie (invisibles dans le catalogue public classé). " +
        "Permet de créer ou modifier une catégorie.",
      inputSchema: {
        creer: z.string().optional().describe("Intitulé d'une catégorie à créer"),
        modifier: z.string().optional().describe("Catégorie à modifier (intitulé ou id)"),
        nouvel_intitule: z.string().optional(),
        parent: z.string().optional().describe("Catégorie parente (intitulé ou id)"),
        description: z.string().optional(),
        active: z.boolean().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const cats = await client.list("categories_module.php");
      const trouver = (q: string) => (/^\d+$/.test(q) ? cats.filter((c) => String(c.id_categorie_module) === q) : cats.filter((c) => normalize(c.intitule) === normalize(q)));
      if (args.creer || args.modifier) {
        let existante: Row | undefined;
        if (args.modifier) {
          const r = single(trouver(args.modifier), "Catégorie");
          if (!("row" in r)) return json(r);
          existante = r.row;
        } else if (trouver(args.creer!).length) {
          return json({ erreur: "Une catégorie de ce nom existe déjà.", existantes: trouver(args.creer!) });
        }
        let idParent: string | undefined;
        if (args.parent) {
          const p = single(trouver(args.parent), "Catégorie parente");
          if (!("row" in p)) return json(p);
          idParent = String(p.row.id_categorie_module);
        }
        const body = champs({
          intitule: existante ? args.nouvel_intitule ?? existante.intitule : args.creer, description: args.description,
          id_parent: idParent, status: args.active === undefined ? undefined : args.active ? 1 : 0,
        });
        return appliquer(args.dry_run, { action: existante ? "modification" : "creation", valeurs: body }, () =>
          client.post("categories_module.php", existante ? { id_categorie_module: existante.id_categorie_module, ...body } : body),
        );
      }
      const modules = await client.list("modules.php", { fields: "id_module,intitule,numero_complet,id_categorie_module,catalogue" });
      const parParent = new Map<string, Row[]>();
      for (const c of cats) parParent.set(String(c.id_parent ?? "0"), [...(parParent.get(String(c.id_parent ?? "0")) ?? []), c]);
      const nbModules = (id: string) => modules.filter((m) => String(m.id_categorie_module) === id).length;
      const arbre = (parent: string): unknown[] =>
        (parParent.get(parent) ?? []).map((c) => ({ id: c.id_categorie_module, intitule: c.intitule, actif: vrai(c.status ?? 1), nb_modules: nbModules(String(c.id_categorie_module)), sous_categories: arbre(String(c.id_categorie_module)) }));
      const sansCategorie = modules.filter((m) => !m.id_categorie_module || String(m.id_categorie_module) === "0");
      return json({
        categories: arbre("0"),
        modules_sans_categorie: sansCategorie.map((m) => ({ id_module: m.id_module, numero: m.numero_complet, intitule: m.intitule, au_catalogue: vrai(m.catalogue) })),
      });
    },
  );

  server.registerTool(
    "enregistrer_formateur",
    {
      description:
        "Crée ou modifie le formateur `formateur` (prénom nom ou id ; vide = création) : statut, statut BPF, rémunération, " +
        "n° de déclaration d'activité (`num_da`), coordonnées, entreprise fournisseur de rattachement ; détecte les doublons " +
        "(nom + prénom, email). Ou le supprime.",
      inputSchema: {
        formateur: z.string().optional(),
        supprimer: z.boolean().default(false),
        nom: z.string().optional(),
        prenom: z.string().optional(),
        civilite: z.string().optional(),
        email_pro: z.string().optional(),
        email_perso: z.string().optional(),
        telephone_pro: z.string().optional(),
        telephone_perso: z.string().optional(),
        adresse: z.string().optional(),
        code_postal: z.string().optional(),
        ville: z.string().optional(),
        statut: z.enum(["travailleur_independant", "cdi", "cdd", "occasionnel", "benevoles", "exterieur"]).optional(),
        statut_bpf: z.enum(["interieur", "exterieur"]).optional(),
        mode_remu: z.enum(["horaire", "journalier"]).optional(),
        remu_horaire_par_defaut: z.number().optional(),
        remu_journaliere_par_defaut: z.number().optional(),
        num_da: z.string().optional(),
        profession: z.string().optional(),
        biographie_catalogue: z.string().optional(),
        entreprise: z.string().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      let existant: Row | undefined;
      if (args.formateur) {
        const f = single(await findFormateur(client, args.formateur), "Formateur");
        if (!("row" in f)) return json(f);
        [existant] = await client.list("formateurs.php", { id: String(f.row.id_formateur) });
      }
      if (args.supprimer) {
        if (!existant) return json({ erreur: "Préciser le formateur à supprimer." });
        const lafs = await client.list("lafs.php", { id_formateur: String(existant.id_formateur) });
        if (lafs.length > 0) return json({ erreur: `Formateur staffé sur ${lafs.length} session(s) : suppression refusée.` });
        return appliquer(args.dry_run, { action: "suppression", formateur: nomDe(existant) }, () => client.delete("formateurs.php", { id: String(existant!.id_formateur) }));
      }
      if (!existant && (!args.nom || !args.prenom)) return json({ erreur: "nom et prenom requis pour créer un formateur." });
      let idEntreprise: string | undefined;
      if (args.entreprise) {
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        idEntreprise = String(e.row.id_entreprise);
      }
      const body = champs({
        nom: args.nom, prenom: args.prenom, civilite: args.civilite, email_pro: args.email_pro, email_perso: args.email_perso,
        telephone_pro: args.telephone_pro, telephone_perso: args.telephone_perso, adresse: args.adresse, code_postal: args.code_postal,
        ville: args.ville, statut: args.statut, statut_bpf: args.statut_bpf, mode_remu: args.mode_remu,
        remu_horaire_par_defaut: args.remu_horaire_par_defaut, remu_journaliere_par_defaut: args.remu_journaliere_par_defaut,
        num_da: args.num_da, profession: args.profession, biographie_catalogue: args.biographie_catalogue, id_entreprise: idEntreprise,
      });
      if (Object.keys(body).length === 0) return json({ erreur: "Aucune valeur à enregistrer." });
      if (!existant) {
        const proches = await findFormateur(client, `${args.prenom} ${args.nom}`);
        const meme = proches.filter((f) => normalize(`${f.prenom} ${f.nom}`) === normalize(`${args.prenom} ${args.nom}`) || (args.email_pro && normalize(f.email_pro) === normalize(args.email_pro)));
        if (meme.length) return json({ erreur: "Formateur probablement déjà existant : le modifier plutôt que le recréer.", doublons: meme });
      }
      const recap = {
        action: existant ? "modification" : "creation",
        formateur: existant ? nomDe(existant) : `${args.prenom} ${args.nom}`,
        ...(existant ? { avant: Object.fromEntries(Object.keys(body).filter((k) => k in existant!).map((k) => [k, existant![k]])) } : {}),
        valeurs: body,
      };
      return appliquer(args.dry_run, recap, () => client.post("formateurs.php", existant ? { id_formateur: existant.id_formateur, ...body } : body));
    },
  );

  server.registerTool(
    "creer_salle",
    {
      description:
        "Crée une salle `type` : interne (centre de formation `centre`, id), externe (hors centre), virtuelle (e-learning, " +
        "`url_connexion`) ou chez le client (`entreprise`). Modification et suppression : dans Dendreo (refusées par l'API). " +
        "`lister_centres=true` liste les centres de formation.",
      inputSchema: {
        lister_centres: z.boolean().default(false),
        intitule: z.string().optional(),
        type: z.enum(["interne", "externe", "virtuelle", "chez_le_client", "chez_le_client_hors_site"]).optional(),
        centre: z.string().optional(),
        entreprise: z.string().optional(),
        capacite_max: z.number().int().optional(),
        adresse: z.string().optional(),
        code_postal: z.string().optional(),
        ville: z.string().optional(),
        telephone: z.string().optional(),
        email: z.string().optional(),
        acces: z.string().optional(),
        url_connexion: z.string().optional(),
        acces_handicapes: z.boolean().optional(),
        acces_handicapes_desc: z.string().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      if (args.lister_centres) return json({ centres: await client.list("centres_de_formation.php") });
      if (!args.intitule || !args.type) return json({ erreur: "intitule et type requis." });
      const cible = { interne: "interne", externe: "cdf_outside", virtuelle: "elearning", chez_le_client: "client", chez_le_client_hors_site: "client_outside" }[args.type];
      let emplacement: string = cible;
      if (args.type === "interne" && args.centre) emplacement = args.centre;
      let idEntreprise: string | undefined;
      if (args.type.startsWith("chez_le_client")) {
        if (!args.entreprise) return json({ erreur: "entreprise requise pour une salle chez le client." });
        const e = single(await findEntreprise(client, args.entreprise), "Entreprise");
        if (!("row" in e)) return json(e);
        idEntreprise = String(e.row.id_entreprise);
      }
      const doublons = (await findSalle(client, args.intitule)).filter((s) => normalize(s.intitule) === normalize(args.intitule));
      if (doublons.length) return json({ erreur: "Une salle de ce nom existe déjà.", doublons });
      const body = champs({
        intitule: args.intitule, emplacement_cible: emplacement, id_entreprise: idEntreprise, capacite_max: args.capacite_max,
        adresse: args.adresse, code_postal: args.code_postal, ville: args.ville, telephone: args.telephone, email: args.email, acces: args.acces,
        url_connexion: args.url_connexion, acces_handicapes: args.acces_handicapes === undefined ? undefined : args.acces_handicapes ? 1 : 0,
        acces_handicapes_desc: args.acces_handicapes_desc,
      });
      return appliquer(args.dry_run, { action: "creation", valeurs: body }, () => client.post("salles_de_formation.php", body));
    },
  );

  server.registerTool(
    "planification_progressive",
    {
      description:
        "Lecture : pour chaque module d'une session, heures prévues comparées aux heures planifiées sur des créneaux (reste à planifier). " +
        "Écriture : ajoute un module à une session existante (avec une durée pour une planification progressive) ou crée une séance " +
        "alternative d'un module programmé (option multi-séance de Dendreo).",
      inputSchema: {
        session: SESSION,
        ajouter_module: z.string().optional().describe("Module à programmer dans la session (intitulé, MOD_… ou id)"),
        date_debut: DATE.optional().describe("Date de début du module ajouté"),
        date_fin: DATE.optional(),
        duree_heures: z.number().optional().describe("Durée en heures : planification progressive, sans créneaux"),
        prix: z.number().optional(),
        seance_alternative_de: z.string().optional().describe("Module (intitulé, MOD_… ou id) ou id_lam dont on crée une séance alternative"),
        dry_run: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const s = single(await findSession(client, args.session, "id_action_de_formation,numero_complet,intitule"), "Session");
      if (!("row" in s)) return json(s);
      const idAdf = String(s.row.id_action_de_formation);
      const session = `${s.row.numero_complet} — ${s.row.intitule}`;
      const [lams, creneaux] = await Promise.all([
        client.list("lams.php", { id_action_de_formation: idAdf }),
        client.list("creneaux.php", { id_action_de_formation: idAdf }),
      ]);
      if (args.ajouter_module) {
        const m = single(await findModule(client, args.ajouter_module), "Module");
        if (!("row" in m)) return json(m);
        if (!args.date_debut && !args.duree_heures) return json({ erreur: "date_debut requise (ou duree_heures pour une planification progressive)." });
        const body = champs({ id_action_de_formation: idAdf, id_module: m.row.id_module, date_debut: args.date_debut, date_fin: args.date_fin, duree: args.duree_heures, prix: args.prix });
        return appliquer(args.dry_run, { session, action: "ajout_module", module: m.row.intitule, valeurs: body }, () => client.post("lams.php", body));
      }
      if (args.seance_alternative_de) {
        const q = args.seance_alternative_de;
        let lam = lams.filter((l) => String(l.id_lam) === q);
        if (lam.length === 0) {
          const ids = new Set((await findModule(client, q)).map((x) => String(x.id_module)));
          lam = lams.filter((l) => ids.has(String(l.id_module)));
        }
        const r = single(lam, "Module programmé");
        if (!("row" in r)) return json(r);
        return appliquer(args.dry_run, { session, action: "seance_alternative", id_lam: r.row.id_lam }, () => client.post("lams.php", { id_lam: r.row.id_lam, create_shadow: 1 }));
      }
      const modules = new Map<string, Row>();
      for (const id of new Set(lams.map((l) => String(l.id_module)))) {
        const [m] = await client.list("modules.php", { id, fields: "id_module,intitule,duree_heures" });
        if (m) modules.set(id, m);
      }
      const lignes = lams.map((l) => {
        const mod = modules.get(String(l.id_module));
        const prevu = num(l.duree) || num(mod?.duree_heures);
        const planifie = arrondi(creneaux.filter((c) => String(c.id_lam) === String(l.id_lam)).reduce((a, c) => a + heuresCreneau(c), 0));
        return { id_lam: l.id_lam, module: l.intitule ?? mod?.intitule, heures_prevues: prevu, heures_planifiees: planifie, reste_a_planifier: arrondi(Math.max(prevu - planifie, 0)) };
      });
      return json({ session, modules: lignes, a_planifier: lignes.filter((l) => l.reste_a_planifier > 0).length });
    },
  );
}
