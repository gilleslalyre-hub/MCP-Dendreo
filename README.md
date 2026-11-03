# MCP-Dendreo

Serveur MCP qui permet à Claude (claude.ai) d'interroger l'API de Dendreo.

## Outils

Le serveur expose 66 outils regroupés par thème. Pour chaque thème, la **lecture** consulte Dendreo sans rien modifier ; l'**écriture** est toujours en **simulation par défaut** (`dry_run=true`) : l'outil montre ce qu'il ferait, et rien n'est écrit tant que l'utilisateur n'a pas confirmé. Un outil qui sait lire et écrire apparaît dans les deux tableaux.

### Sessions et planning

Lecture :

| Outil | Rôle |
|---|---|
| `rechercher_sessions` | Recherche par formation, formateur, entreprise, type, étape, texte libre et période (sans période = sessions à venir ; `mois` : un mois donné ; `limite`) |
| `detail_session` | Fiche complète d'une session : modules, créneaux, formateurs, participants |
| `conflits_planning` | Formateurs ou salles réservés sur deux créneaux qui se chevauchent |
| `entreprises_session` | Entreprises rattachées à une session et leur contact référent |
| `sessions_permanentes` | Sessions permanentes (entrées et sorties permanentes) d'un module |
| `prochaines_sessions_catalogue` | Sessions visibles sur le catalogue en ligne |
| `agenda` | Vue agenda d'une période par formateur (= planning d'un formateur), salle ou entreprise : créneaux, étape, remplissage |
| `occupation_salles` | Taux d'occupation des salles sur une période |
| `preinscriptions` | Sessions qui ont reçu des pré-inscriptions du catalogue public à traiter |

Écriture :

| Outil | Rôle |
|---|---|
| `creer_session` | Crée une session pour un module, sur des jours précis, avec formateur, étape, salle, entreprise INTRA, prix, places, champs personnalisés |
| `dupliquer_session` | Recrée une session existante sur de nouvelles dates |
| `modifier_session` | Étape, intitulé, salle, places, responsable, commentaires, publication en ligne, émargement, champs personnalisés |
| `gerer_creneaux` | Ajoute, modifie ou décale des créneaux, définit la salle ou le lien visio d'un créneau (alerte si la capacité est inférieure aux inscrits) ; un créneau émargé est refusé par Dendreo |
| `entreprises_session` | Change le contact référent d'une entreprise pour la session |
| `sessions_permanentes` | Modifie prix, durée, ouverture ou garantie d'une session permanente |
| `planification_progressive` | Heures prévues et planifiées par module ; ajoute un module à une session existante ; crée une séance alternative |
| `supprimer_fiche` | Supprime une session (refusé s'il y a des inscrits, des présences ou des factures) ; voir aussi la partie CRM |

`creer_session` enchaîne : `actions_de_formation.php` (avec `id_module` et `id_formateur`) → `lams.php` → alignement de `creneaux.php` sur les jours demandés (les créneaux générés par défaut hors de ces jours sont retirés) → `lcfs.php` pour staffer le formateur sur chaque créneau.

### Inscriptions

Lecture :

| Outil | Rôle |
|---|---|
| `rechercher_participant` | Participants par email, nom ou date de naissance, avec leurs formations |
| `inscription_modules` | Modules suivis par chaque participant d'une session multi-modules |
| `souhaits_formation` | Souhaits de formation par module ou participant (qui attend une session ?) |

Écriture :

| Outil | Rôle |
|---|---|
| `inscrire_participants` | Inscrit une liste de participants (créés dans le CRM s'ils n'existent pas), ignore les déjà inscrits, ajoute des non identifiés |
| `modifier_inscription` | Prix, n° de dossier CPF, suivi pédagogique, champs personnalisés d'une inscription |
| `transferer_inscription` | Déplace un participant vers une autre session |
| `annuler_inscription` | Désinscrit des participants (refusé si des présences sont saisies) |
| `inscription_modules` | Inscrit ou désinscrit un participant d'un module |
| `souhaits_formation` | Ajoute ou supprime des souhaits de formation |

### Formateurs

Lecture :

| Outil | Rôle |
|---|---|
| `formateurs_disponibles` | Formateurs aptes à un module et libres aux dates voulues |
| `suivi_rsvp` | Confirmations (Oui / Non / Peut-être) des formateurs créneau par créneau |

Écriture :

| Outil | Rôle |
|---|---|
| `staffer_formateur` | Ajoute un formateur ou une entreprise sous-traitante à une session (tous les créneaux ou certains jours), en remplaçant éventuellement un autre |
| `enregistrer_formateur` | Crée, modifie ou supprime une fiche formateur (statut, statut BPF, rémunération, n° de déclaration d'activité), avec détection des doublons |
| `staffer_formateur` (`retirer=true`) | Déstaffe un formateur (certains jours ou toute la session) |

### Suivi pédagogique

Lecture :

| Outil | Rôle |
|---|---|
| `feuille_presence` | Présences/absences par participant et créneau, heures suivies, assiduité |
| `emargements_manquants` | Créneaux passés sans présence renseignée, pour une session ou une période |
| `taches_en_attente` | Émargements, signatures et questionnaires en attente sur l'extranet, avec les liens de relance |
| `evaluations` | Réussite par module, notes, compétences acquises |
| `satisfaction` | Rapport de satisfaction par session, formateur ou formation : taux de réponse, non-répondants, moyennes par module et par formateur, détail par question, verbatims ; avec `seuil_pourcent` : appréciations négatives sur une période ; relance des non-répondants : `taches_en_attente` (types=satisfaction, autologin) |
| `emargements_manquants` (`controle=signatures`) | Créneaux passés où le formateur ou des participants n'ont pas signé |
| `controle_conformite_session` | Avant les attestations : présences manquantes, émargements non signés, participants éligibles |

Écriture :

| Outil | Rôle |
|---|---|
| `saisir_presences` | Marque présent ou absent (justifié ou non, partiel) sur des jours ou créneaux |
| `evaluations` (avec `participant`) | Enregistre une évaluation de module ou de compétence |

### Catalogue

Lecture :

| Outil | Rôle |
|---|---|
| `catalogue` | Modules (durée, prix, formateurs aptes), formateurs, entreprises, salles, étapes |
| `categories_modules` | Arborescence des catégories de modules et modules sans catégorie (invisibles au catalogue classé) |

Écriture :

| Outil | Rôle |
|---|---|
| `enregistrer_module` | Crée, modifie ou supprime un module : contenu pédagogique, durée, prix, catégorie, formateurs aptes, planning type |
| `categories_modules` | Crée ou modifie une catégorie de modules |
| `enregistrer_formateur` | Crée, modifie ou supprime une fiche formateur |
| `creer_salle` | Crée une salle interne, externe, virtuelle ou chez le client (l'API refuse la modification et la suppression) |

### CRM et commercial

Lecture :

| Outil | Rôle |
|---|---|
| `fiche_entreprise` | Vue 360° : coordonnées, contacts, participants, formations, actions commerciales, opportunités |
| `actions_commerciales` | Échanges d'une entreprise ou d'un commercial, relances à venir |
| `opportunites` | Pipe commercial par étape ou entreprise, avec devis et sessions issues des devis |
| `qualite_crm` | Doublons (SIRET, raison sociale), entreprises sans contact principal ou de facturation, participants sans email |

Écriture :

| Outil | Rôle |
|---|---|
| `enregistrer_entreprise` | Crée ou met à jour une entreprise, avec détection des doublons (SIRET, raison sociale) |
| `enregistrer_contact` | Crée ou met à jour un contact d'entreprise (principal, secondaire, facturation) |
| `enregistrer_participant` | Crée ou met à jour un participant, retrouvé par id ou email |
| `convertir_particulier` | `vers_particulier` : participant ou entreprise → particulier ; `vers_entreprise` : particulier → entreprise + contact + participant |
| `enregistrer_particulier` | Crée ou met à jour un particulier, retrouvé par id ou email |
| `importer_crm` | Import en masse d'entreprises, contacts, participants ou particuliers, avec dédoublonnage (SIRET, raison sociale, email) |
| `supprimer_fiche` | Supprime un participant, un contact, une entreprise ou une action commerciale, avec garde-fous ; `restaurer=true` restaure une entreprise |
| `actions_commerciales` | Ajoute un compte rendu d'échange avec une date de relance |
| `opportunites` | Crée une opportunité pour une entreprise |

### Documents, fichiers et emails

Lecture :

| Outil | Rôle |
|---|---|
| `generer_document` | Génère convocation, convention, attestation, facture, devis, document module × participant… depuis un modèle Dendreo et renvoie le fichier |
| `fichiers` | Fichiers d'une session ou d'une fiche (espace de stockage, partages) |
| `suivi_emails` | Emails envoyés par Dendreo et statut de chaque destinataire (délivré, rejeté…), filtres par statut, destinataire et période, pagination |
| `checklist` | Avancement des checklists d'une session, d'un formateur ou d'un module |

Écriture :

| Outil | Rôle |
|---|---|
| `fichiers` | Dépose ou supprime des fichiers (lien à une entité de la session, dépôt sans cible pour le tri par QR code, collections de partage) |
| `checklist` | Coche, décoche, ajoute, renomme ou supprime des points ; vue portefeuille des sessions INTER incomplètes |

L'API Dendreo ne permet pas d'envoyer un email : l'envoi, la programmation et les automatismes restent dans Dendreo.

### Hors de portée de l'API

Ces besoins ne sont pas réalisables par le serveur : envoi d'emails et invitations RSVP, configuration du compte (étapes, questionnaires, modèles de checklists, formulaires CRM), création et modification de financements, chiffres agrégés et télé-déclaration du BPF, réclamations, signature d'émargement, modification et suppression de salles, fusion de doublons, webhooks entrants.

### Finance et facturation

Lecture :

| Outil | Rôle |
|---|---|
| `factures` | Factures par session, entreprise, financeur ou période : montants, restant dû, échéance, statut, niveau de relance, lien PDF |
| `factures` (`vue=impayes`) | Factures échues non soldées, groupées par client ou financeur, avec le retard en jours |
| `reglements` | Règlements par facture ou période |
| `financements` | Qui finance quoi sur une session, une entreprise ou un financeur : financé, facturé, payé, participants concernés |
| `financeurs` | Recherche d'un financeur (OPCO…), ses factures et ses contacts |
| `bilan_financier_session` | CA prévu comparé au financé, au facturé et à l'encaissé ; alerte sur les sessions non facturées |
| `export_comptable` | Fichier d'export des ventes (Sage, EBP, Cegid, Quadra…) pour des factures ou un lot |

Écriture :

| Outil | Rôle |
|---|---|
| `reglements` | Saisit, modifie ou supprime un règlement (refusé s'il est déjà exporté en comptabilité) |
| `financements` | Supprime un financement (la création et la modification ne sont pas possibles via l'API) |

### Exports et indicateurs

Lecture :

| Outil | Rôle |
|---|---|
| `telecharger_export` | Télécharge n'importe quel export du menu Reporting de Dendreo sur une période (une soixantaine d'exports : activité, BPF, finance, qualité, clients) |
| `indicateurs_activite` | Sessions, stagiaires, heures-stagiaires, remplissage, CA facturé par mois, avec comparaison N / N-1 |
| `pilotage_adf` | Portefeuille de sessions par étape et type (INTER / INTRA) : inscrits, heures, financé, facturé, payé |

La liste des slugs d'export figure dans la description de `telecharger_export`.

### BPF, qualité et conformité

Lecture :

| Outil | Rôle |
|---|---|
| `controle_bpf` | Sessions exclues ou mal renseignées pour le BPF : case décochée, étape non confirmée, sans financement, présences manquantes, objectif ou spécialité vides |
| `qualite_crm` (`controle=statuts_bpf`) | Participants au statut BPF non renseigné, entreprises qui ressemblent à un financeur |
| `sous_traitance` | Intervenants extérieurs et financements de sous-traitance (cadres F-2 et G du BPF) |
| `dpc` | Modules éligibles DPC, sessions sans numéro DPC, participants sans ADELI / RPPS |

Écriture :

| Outil | Rôle |
|---|---|
| `sous_traitance` | Bascule le statut BPF d'un formateur d'une session entre intérieur et extérieur |

Les chiffres agrégés du BPF et la télé-déclaration restent dans Dendreo : les outils ne contrôlent que les données sources.

### Synthèses

Lecture :

| Outil | Rôle |
|---|---|
| `tableau_de_bord_session` | « Où en est la session ? » : remplissage, staffing, assiduité, tâches en attente, emails en échec, checklists, points d'attention |
| `relances_a_faire` | Participants à relancer sur une période (émargement, signature, questionnaire, email non délivré), avec les liens |

### Exploration

Lecture :

| Outil | Rôle |
|---|---|
| `dendreo_get` | Lecture brute de n'importe quelle ressource de l'API |

## Configuration

Variables d'environnement (voir `.env.example`) :

| Variable | Rôle |
|---|---|
| `DENDREO_SLUG` | identifiant de l'instance (`https://pro.dendreo.com/<slug>/api/`) |
| `DENDREO_API_KEY` | clé API Dendreo |
| `MCP_AUTH_TOKEN` | jeton secret exigé dans l'URL du connecteur (`?token=`) ou en `Authorization: Bearer` |
| `MCP_MESURE` | optionnel : `0` désactive la mesure des réponses (voir ci-dessous) |

## Mesure de la consommation

Chaque appel d'outil écrit une ligne dans les journaux, sans les arguments ni le contenu :

```json
{"mcp_outil":"factures","cars":5210,"tokens_estimes":1489,"ms":840}
```

Sur Vercel : projet > **Logs**, rechercher `mcp_outil`. Les outils qui reviennent souvent avec beaucoup de `tokens_estimes` sont ceux à alléger en priorité.

## Test en local

```bash
npm install
DENDREO_SLUG=... DENDREO_API_KEY=... MCP_AUTH_TOKEN=... npm run dev
npx @modelcontextprotocol/inspector   # URL : http://localhost:3000/api/mcp?token=...
```

## Déploiement (Vercel) et branchement à claude.ai

1. Importer le dépôt dans Vercel et renseigner les trois variables d'environnement.
2. Dans claude.ai : Paramètres > Connecteurs > Ajouter un connecteur personnalisé, URL :
   `https://<app>.vercel.app/api/mcp?token=<MCP_AUTH_TOKEN>`
