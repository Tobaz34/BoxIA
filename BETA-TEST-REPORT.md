# 🧪 Beta-test report — AI Box (chat + admin)

> **Persona** : dirigeant TPE/PME, semi-tech, qui découvre l'app via Chrome après login. 30 min de parcours.
> **Box testée** : `http://192.168.15.210:3100/` — admin / aibox-changeme2026
> **Date** : 2026-04-30

---

## 🚨 Bugs bloquants à corriger en priorité

| # | Page | Bug | Fix |
|---|---|---|---|
| 1 | `/help` | **404 page not found** + le layout casse (bannière devient blanc clair) | Créer la page `app/help/page.tsx` ou rediriger l'item menu vers une vraie URL |
| 2 | `/users` | `authentik Default Admin` (akadmin) et `Outpost authentik Embedded Outpost Service-Account` apparaissent dans la liste des utilisateurs métier | Filtrer côté `/api/users` les comptes système |
| 3 | `/agents` modal Configurer | **2 sources de vérité divergentes** pour `opening_statement` et `suggested_questions` : `lib/agents.ts` (statique, code) vs Dify DB (dynamique, modal). Le chat affiche le statique, la modal édite le dynamique | Soit lire Dify dans le chat, soit cacher les champs dans la modal |
| 4 | `/system` | Les ressources CPU/RAM/Disk/GPU étaient vides au chargement (Prometheus pas encore scrapé). Au moins afficher un skeleton/loading | Skeleton loaders pendant que Prometheus scrape |
| 5 | Bannière password change | Persistante après "J'ai changé". L'état n'est pas persisté côté client | Stocker `password_change_dismissed` en localStorage + appel API qui clear le flag Authentik |
| 6 | Chat (CAF tronquée) | La génération comptable a coupé à la 6e section (CAF) sur "•" vide | Augmenter `num_predict` Dify de l'agent général à 4096 (vs 2048 default) |

---

## 📋 Critique par page (par ordre d'importance)

### 1. `/` — Discuter (chat)

**👍 Points positifs**
- Empty state propre avec emoji robot, opening personnalisé
- 4 suggestions adaptées à l'agent sélectionné
- Hints visibles pour découvrir features (drag-drop, micro, slash)
- Métriques live CPU/RAM/Disk/GPU en haut
- Auto-scroll, auto-rename de conversation
- Boutons d'action sur chaque message (Copy, TTS, Régen, Like, Dislike)
- Follow-up suggestions Dify (chips post-réponse)

**❌ Frictions / améliorations**
- **L'opening pourrait être personnalisé avec le prénom user** : "Bonjour André, comment puis-je vous aider aujourd'hui ?" plutôt que générique
- **Conversations passées non groupées par date** (Aujourd'hui / Hier / Cette semaine / Plus ancien). Liste plate "il y a 14 min", "il y a 16 min" → ne scale pas à 50+ conv
- **Pas de recherche** dans les conversations (search box au-dessus de la liste)
- **Pas de pin / archive / favoris** de conversation importante
- **Pas d'indication de quel modèle est utilisé** (qwen2.5:7b vs qwen2.5vl) — l'admin pourrait vouloir savoir
- **Pas de séparateur visuel** clair entre user et assistant message (juste l'avatar à gauche)
- **Le download icon (export MD)** en haut à droite est petit et discret. Ajouter un tooltip plus visible ou un bouton "Exporter…" avec menu (MD / PDF / TXT)
- **Pas de mode plein écran** pour les longues réponses (utile sur petit écran TPE)
- **Streaming response sans timer** : pas de "génération en cours depuis 8s…" pour rassurer sur les longues attentes
- **Pas d'historique des prompts** récents (flèche haut comme un terminal)
- **Pas de "stop generation"** rapide via Esc seul (ça marche en raccourci mais pas évident)

**Quick wins (< 1h chaque)**
- Personnaliser l'opening avec `session.user.name`
- Grouper conversations par date (Today / Yesterday / This week / Older)
- Search bar sticky au-dessus de la liste
- Tooltip sur le bouton export

**Long terme**
- PDF export propre
- Pin/archive
- Templates de prompts personnels par user
- Markdown editor mode (preview à droite, source à gauche)

---

### 2. `/agents` — Mes assistants

**👍 Points positifs**
- 4 cartes propres en grille 2x2
- Badges visibilité ("ouvert à tous" / "Admin Manager")
- Badge "défaut" sur Assistant général
- Bouton Configurer ouvre un modal complet (pre-prompt, opening, questions suggérées)
- **Le modèle utilisé est affiché** : "qwen2.5:7b (chat)" ✓

**❌ Frictions**
- **Pas de bouton "Discuter avec cet agent"** sur chaque carte → friction (forcé de retourner dans Discuter et utiliser le picker)
- **Pas de stats par agent** : conversations, dernière utilisation, taux satisfaction (likes/dislikes ratio)
- **Pas de "Créer un nouvel assistant"** → bloqué avec les 4 par défaut. Or c'est un argument vente fort de pouvoir customiser ("Assistant juridique", "Assistant ventes")
- **Layout 2x2** ne scale pas à 10 agents — ajouter filtre rôle/type
- **Pas de duplication** d'agent ("Dupliquer Assistant comptable" → créer Assistant audit)
- **Pas de slider temperature** dans le modal (plus créatif vs plus factuel)
- **Pas de max_tokens** configurable → cause la troncation observée
- **Pas de "Tester l'agent" inline** dans le modal (preview chat)

**Quick wins**
- Bouton "💬 Discuter" sur chaque card (mène à `/?agent=<slug>`)
- Stats compteur conversations sur chaque card
- Sliders temperature + max_tokens dans le modal

**Long terme**
- Création d'agents custom (vendre comme module premium ?)
- Marketplace d'agents pré-configurés par secteur (BTP, juridique, médical)
- Versioning des prompts (rollback en cas de régression)

---

### 3. `/workflows` — Automatisations

**👍 Points positifs**
- Header simple + bouton "Ouvrir n8n"
- Note explicative claire en bas

**❌ Frictions**
- **Page totalement vide** alors que `templates/n8n/` contient des workflows pré-écrits (workflow_email_digest_quotidien, workflow_relance_factures_impayees) qui ne sont jamais importés
- **"Ouvrir n8n"** mène vers `https://aibox-flows.local` qui ne marche pas pour un user sans Bonjour. Devrait pointer vers `http://192.168.15.210:5678`
- **Pas de bibliothèque de workflows pré-configurés** type Zapier/Make (gallery)
- **Pas de wizard "Créer mon premier workflow"** ("Email reçu → résumer → Slack")
- **Pas de filtres / search** quand il y a des workflows

**Quick wins**
- Importer auto les 2 workflows du repo au boot
- URL "Ouvrir n8n" dynamique (suit l'host actuel)

**Long terme**
- Gallery de workflows publics (BTP, juridique, retail)
- Workflow builder simple en drag-drop direct dans l'app (sans ouvrir n8n)

---

### 4. `/documents` — Documents (KB partagée)

**👍 Points positifs**
- Drag-drop zone propre, large, claire
- Formats listés explicitement (PDF, Word, Excel, CSV, MD, HTML, JSON · 15 Mo / fichier)
- Empty state avec call-to-action

**❌ Frictions**
- **Aucune indication d'usage** : "ces documents seront utilisés par tous les assistants pour répondre à vos questions" → manque ce micro-contexte rassurant
- **Pas de progress bar** pendant l'upload + pendant l'indexation Dify (peut prendre 30s-2min selon taille)
- **Pas de prévisualisation** du PDF/DOCX importé (juste nom + taille)
- **Pas d'organisation par dossiers / tags** — ça scaling mal à 100+ docs
- **Pas de recherche** dans la liste des docs

**Quick wins**
- Texte "Tous les assistants pourront répondre sur ces documents" sous le titre
- Progress bar upload + status badge "Indexation..." → "Indexé ✓"
- Search bar

**Long terme**
- Tags / dossiers
- Version control (réimporter le même fichier garde l'historique)
- Permission par doc (admin only / public / spécifique groupe)

---

### 5. `/users` — Utilisateurs

**👍 Points positifs**
- Tableau clair User/Rôle/Statut/Dernière connexion + "..."
- Search bar
- Bouton "Inviter un utilisateur"
- Compteur "3 comptes · Géré via Authentik"

**❌ Frictions**
- 🚨 **Comptes système visibles** : `authentik Default Admin` (akadmin) et `Outpost authentik Embedded Outpost Service-Account` polluent la liste métier
- **Rôle "Employe"** sans accent (devrait être "Employé")
- **Pas de filtres** par rôle (Admin / Manager / Employé)
- **Pas d'export CSV** des users (utile reporting RGPD)
- **Pas de bulk-actions** (sélection multiple + désactiver / changer rôle)

**Quick wins**
- Filtrer akadmin + outpost-* dans `/api/users`
- Fix typo "Employe" → "Employé"
- Filtre par rôle (chips au-dessus du tableau)

**Long terme**
- Bulk actions
- Provisioning via SCIM / SAML pour les boîtes avec AD

---

### 6. `/connectors` — Connecteurs

**👍 Points positifs**
- 30 connecteurs au catalogue, beaucoup de logos
- Search + filtre par catégorie
- Badges Stable / Bêta / À venir
- Cards lisibles

**❌ Frictions**
- **Tous "Activer"** mais on ne sait pas ce qui se passe au click (OAuth ? credentials form ?)
- **"À venir"** trop nombreux (OneDrive, Dropbox, Box, Gmail) — peut frustrer ou donner un sentiment d'incomplet
- **Pas d'info "ce que cela débloque"** : "Activer Google Drive permettra à vos assistants de répondre sur vos docs Drive"
- **Pas de tri par popularité ou pertinence**
- **Pas de groupement visuel** par catégorie (Stockage / Email / ERP / etc.)

**Quick wins**
- Au click "Activer" : afficher une modal qui explique le flow (OAuth ou form) AVANT de demander les credentials
- Cacher "À venir" derrière un toggle "Voir bientôt disponibles"
- Grouper par catégorie avec des sections

**Long terme**
- Drag-drop d'un connecteur vers une conversation (ex: drag Drive → "fais-moi une recherche dans ce drive")

---

### 7. `/audit` — Journal d'audit

**👍 Points positifs**
- Onglets Application / Système (Authentik) — bonne séparation
- Filtre par email/actor + dropdown actions

**❌ Frictions**
- **0 événement** alors qu'on a fait 6 logins, 3 conversations, 2 switches d'agent. `logAction()` n'est appelé que sur les routes settings/admin — devrait logger aussi : login, send msg, agent switch, doc upload
- **Pas d'export CSV** ou JSON des événements
- **Pas de filtres temporels** (Aujourd'hui / 7 derniers jours / 30 jours)

**Quick wins**
- Logger les actions critiques métier (login, chat.send, agent.switch, doc.upload)
- Filtre temporel
- Bouton Export CSV

**Long terme**
- Alerts configurables ("Notifier moi quand un user désactivé tente de login")

---

### 8. `/system` — État du serveur

**👍 Points positifs**
- 5/5 services opérationnels (après fix)
- Latence par service (3ms, 7ms, 8ms…)
- Métriques live CPU/RAM/Disk/GPU avec couleurs
- KPI Activité (utilisateurs, assistants, conversations, docs, connecteurs, actions 24h)
- Conversations par agent (barre d'usage)

**❌ Frictions**
- **Pas de timeline** des incidents (uptime calendar comme Upptime ou StatusCake)
- **Pas d'alertes configurables** ("notifier si Ollama down > 1 min")
- **Métriques temps réel** mais pas de **graphes historiques** (sur 24h, 7j)
- **Pas de "Détails techniques"** pour un admin avancé (versions images, taille volumes, last backup, etc.)

**Quick wins**
- Mini graphes 24h sous chaque resource
- Lien "Voir Grafana" pour les graphes détaillés (Grafana est déjà déployé !)

**Long terme**
- Page d'incidents avec timeline
- Webhook alertes (Slack, Discord, email)

---

### 9. `/settings` — Paramètres

**👍 Points positifs**
- Instructions personnalisées (À propos / Comment répondre) — bon onboarding
- Branding (Nom de la box, Nom du client)

**❌ Frictions**
- **Pas de gestion thème** (clair / sombre / auto) accessible — l'icône en haut existe mais pas de label
- **Pas de gestion langue** (FR / EN — utile si on vend hors France)
- **Pas de configuration notifications** (email digest, push browser)
- **Pas de section "À propos"** avec version BoxIA + dernière mise à jour

**Quick wins**
- Ajouter section Notifications
- Ajouter section "À propos" avec version git + uptime
- Toggle thème dans la même page

---

### 10. `/me` — Mes données (RGPD)

**👍 Très bien fait** — RGPD compliant
- Profil, export JSON (art. 20), suppression conversations (art. 17 = admin)

**❌ Frictions**
- **Pas de modal de confirmation** au click "Supprimer toutes mes conversations" (à vérifier)
- **Pas de stats personnelles** : "Vous avez 4 conversations, 12 messages, X tokens utilisés"
- **Pas de gestion des "données d'apprentissage"** (révoquer un doc privé indexé)

**Quick wins**
- Modal "Tape SUPPRIMER pour confirmer"
- Section stats user

---

### 11. `/help` — 🚨 404 (à créer)

**Bug bloquant** — l'item menu Aide pointe sur du néant.

**Proposition de contenu pour cette page** :
- 🎬 **Vidéo de prise en main** 90s (drag-drop PDF, voice, slash, agent switch)
- 📝 **FAQ** : Que faire si l'IA ne répond pas ? Comment ajouter un user ? Comment changer le mdp ?
- 🔗 **Liens** : doc complète, support email, repo GitHub
- 🎁 **Tour guidé** interactif (highlight chaque feature au démarrage si nouveau user)
- 🐛 **"Signaler un bug"** : formulaire pré-rempli avec contexte (user, navigateur, dernière action)

---

## 🎨 Critique design global

### 👍
- Dark theme cohérent, sobre, professionnel
- Iconographie lucide-react propre, uniforme
- Couleurs primaires/accent bien dosées (bleu primaire, accent vert)
- Typographie hiérarchique claire
- Transitions et hovers présents

### ❌
- **Pas de logo branded** — juste un hexagone bleu générique. Pour une démo client, ajouter un vrai logo (généré ou upload via /settings)
- **Header avec métriques live** sympa mais **prend de la place** — pourrait être collapsé en 1 ligne minimaliste
- **Bannière password ambre** trop intrusive (occupe toute la largeur en haut). La rendre plus compacte ou dismissable temporairement (24h)
- **Pas de breadcrumbs** sur les pages internes (utile pour navigation)
- **Mode mobile non testé** ici mais nécessaire (tablette TPE)

---

## 📊 Résumé prioritisé

### 🔥 À fixer rapidement (< 4h total)

1. Page `/help` 404 → créer (proposition de contenu ci-dessus)
2. Filtrer akadmin + outpost-* dans `/users`
3. Fix typo "Employe" → "Employé"
4. Bannière password : persister le dismissed
5. Bouton "💬 Discuter" sur chaque card `/agents`
6. Personnaliser opening avec prénom user
7. Conversations groupées par date dans la sidebar
8. URL "Ouvrir n8n" dynamique (pas hardcoded `aibox-flows.local`)
9. Auto-importer les 2 workflows n8n du repo

### 🚀 Mid-term (1-2 jours)

1. Recherche dans conversations + dans documents
2. Création d'agents custom dans `/agents`
3. Stats par agent (conversations, ratings)
4. Modal "ce qui se passe" au click Activer dans `/connectors`
5. Logger plus d'actions dans audit (login, chat.send, etc.)
6. Mini-graphes 24h dans `/system`
7. Sliders temperature + max_tokens dans modal agent
8. Progress upload + status indexation dans `/documents`

### 🌟 Long terme (différenciation produit)

1. Marketplace d'agents pré-configurés par secteur
2. Workflow builder drag-drop direct dans l'app
3. Mode mobile / responsive
4. Backup offsite (Sprint 6 mentionné dans /settings)
5. Onboarding guidé (tour interactif)
6. Vidéo `/help` avec démo 90s

---

## 🎯 Verdict beta-tester

> "Le produit a une **base technique solide**, le chat marche, les fonctionnalités hands-free (voice/TTS/drag-drop/slash) sont **vraiment impressionnantes** pour une box locale. Mais l'**onboarding** manque (pas d'aide, pas de tour, pas de help text) et certains menus sentent **l'incomplet** (workflows vide, connecteurs tous Activer mais flou, audit log vide). Avec 1 sprint d'UX + le `/help`, c'est démo-ready pour un prospect TPE."

**Note globale** : 7/10
- Tech : 9/10
- UX : 6/10
- Onboarding : 4/10
- Démo-readiness : 7/10
