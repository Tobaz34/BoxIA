# BoxIA — Changelog

> Historique humain des versions, mises à jour et correctifs.
> Affiché côté UI dans /settings → carte « Version & mises à jour ».
>
> Format : Sémantique léger (Added / Changed / Fixed / Removed).

---

## [0.2.2] — 2026-05-04

### Added
- **OAuth OIDC pour connecteurs** (Google + Microsoft) : bouton
  « Connecter avec Google/Microsoft » sur les modales connecteurs
  (Drive, Gmail, Calendar, OneDrive, Outlook, SharePoint, Teams).
  Flow Authorization Code + PKCE (popup browser → provider → callback)
  avec fallback Device Flow pour les déploiements LAN sans HTTPS.
  Tokens chiffrés AES-256-GCM at-rest dans `/data/oauth-connections.json`.
  Refresh automatique avant expiration.
- **Domaine HTTPS public** `demo.ialocal.pro` (Cloudflare Tunnel sans
  port-forward, certificat auto, marche derrière NAT). Script
  `tools/configure-aibox-domain.sh` qui prépare `.env` (NEXTAUTH_URL +
  OAUTH_REDIRECT_BASE_URL) et imprime le checklist setup complet.
- **Workers RAG en mode OAuth user-level** : `rag-gdrive` et
  `rag-msgraph` peuvent désormais indexer le Drive du user qui a
  autorisé via la box (au lieu de l'ancien Service Account / App-only
  centralisé). Variable `AUTH_MODE=oauth` (default). Endpoint
  `/api/oauth/internal/token` sert les access_token déchiffrés aux
  workers via shared secret `CONNECTOR_INTERNAL_TOKEN`.

### Changed
- **`NEXTAUTH_URL`** par défaut sur `https://demo.ialocal.pro` (était
  `http://192.168.15.210:3100`). Le callback Authentik et les redirect
  URI Google/Microsoft sont mis à jour automatiquement.
- **Audience consent screen Google** en mode Testing avec test users
  whitelist pendant la verification Google (cf
  `memory/sprint_self_update_oauth_2026-05-03.md`). Stratégie A : flip
  Production sans re-déployer côté boxes une fois la verification
  Google passée (~2-6 semaines délai côté Google).

### Fixed
- **Middleware NextAuth** : exempt `/api/oauth/{callback,internal}/*`
  du gate de session (le callback OAuth arrive de Google/Microsoft sans
  cookie de session, et l'endpoint internal authentifie via shared
  secret côté worker).

---

## [0.2.1] — 2026-05-03

### Added
- **Self-update depuis l'UI** : carte « Version & mises à jour » de
  `/settings` propose maintenant un bouton « Vérifier les mises à jour »
  (compare le commit local au tip de main via GitHub API) et, si retard,
  un bouton « Mettre à jour maintenant » qui déclenche un déploiement
  complet (git fetch + rebuild + smoke test) sans accès SSH au serveur.
- **Connexion GitHub master** : carte « Connexion GitHub » (env-first +
  saisie UI d'un fine-grained PAT, scope minimal Contents Read sur
  Tobaz34/BoxIA). Pré-requis pour le bouton de mise à jour : « pas de
  compte, pas de MAJ ». Token chiffré AES-256-GCM at-rest.

### Fixed
- **Migration `0001_dify_max_tokens_8192`** : flow d'auth Dify ≥1.10
  (cookies httpOnly + X-CSRF-TOKEN au lieu du token dans le body de /login).
- **`tools/deploy-to-xefia.sh`** : `run-pending.py` n'était plus skippé
  silencieusement (`-x` → `-f`), `.env` chargé pour les vars admin requises
  par les migrations, `BUILD_COMMIT_*` exporté pour que `version.json` ait
  le bon commit_sha.

---

## [0.2.0] — 2026-05-01

### Added
- **Marketplace n8n dédiée** (`/workflows/marketplace`) : 9 workflows pré-écrits
  catalogués (Pennylane digest, IMAP triage, GLPI SLA, snapshot Qdrant, healthcheck
  stack, etc.) avec install en 1 clic. Sidebar : nouvelle entrée « Marketplace n8n ».
- **Auto-import marketplace au first-run** : 2 workflows essentiels (Snapshot Qdrant
  hebdo + Healthcheck stack 5 min) importés ET activés automatiquement après
  provisioning.
- **i18n FR / EN** : architecture complète (lib/i18n, hook `useT()`, dict typé).
  Sélecteur de langue dans /settings → carte « Langue de l'interface ». Cookie
  persistant 1 an. Refactor des composants principaux (Sidebar, Header,
  PasswordChangeBanner, marketplaces, settings).
- **Notification credentials manquants** : banner sur /workflows qui liste les
  credentials externes encore à configurer pour les workflows actifs (extrait
  du catalogue marketplace) + bouton SSO direct vers /home/credentials de n8n.
- **Carte « Version & mises à jour »** sur /settings : affiche la version
  courante, la date de build, le commit, et la liste des derniers changements.

### Changed
- **n8n healthcheck** : `localhost` résolvait en IPv6 dans l'image n8n alors
  que le serveur bind en IPv4. Changé en `127.0.0.1` → container plus jamais
  unhealthy.
- **Bannière mot de passe par défaut** : self-healing — auto-clear si Authentik
  a tracé un `password_change_date > date_joined`. Plus besoin de cliquer
  manuellement « J'ai changé ».
- **Activation workflow n8n** : utilise maintenant `PATCH /rest/workflows/<id>
  {active:true}` (n8n 1.70+) avec fallback `POST /<id>/activate` pour
  rétro-compat.
- **Wizard Authentik retry** : 30 minutes max au lieu de 3 minutes (couvre
  les fresh deploys ADSL où le pull d'images peut prendre 15+ min).
- **Uptime Kuma** : retiré du produit (placeholder qui violait le principe
  zéro intervention humaine). Remplacé par Prometheus + Grafana + page
  /system + workflow healthcheck.

### Fixed (P0 reset cycle)
- **Wizard `/api/configure`** : générait UNIQUEMENT certains secrets ;
  `AGENTS_API_KEY`, `MEM0_API_KEY`, 5 `*_TOOL_API_KEY`, `N8N_PASSWORD` et
  6 URLs sidecars étaient générés UNIQUEMENT par `install.sh` interactif.
  En mode wizard web, `.env` était incomplet → connecteurs et sidecars
  refusaient de démarrer. Maintenant tous les secrets sont auto-générés.
- **`setup_n8n_owner` idempotency** : 400 « Instance owner already setup »
  n'était pas géré comme idempotent (uniquement 403/409). Au 2e appel de
  provision-sso → erreur. Maintenant : détection des keywords « already »
  / « instance owner » dans body 400 → ok=true, created=false.
- **`setup_portainer_admin`** : Connection refused traité comme erreur alors
  que Portainer n'est plus dans la stack BoxIA core. Maintenant : skip
  propre si toutes les URLs candidates renvoient Connection refused / DNS.
- **SSO Dify cassé** : Dify 1.10 rejette `application/x-www-form-urlencoded`
  sur `/console/api/login` (exige JSON), JSON cross-origin nécessite CORS
  preflight non configuré. Fix combiné : `CONSOLE_CORS_ALLOW_ORIGINS=*` +
  `WEB_API_CORS_ALLOW_ORIGINS=*` côté Dify compose + `fetch()` JSON avec
  `credentials: include` côté HTML SSO.
- **Procédure reset** : `docker compose down -v` ne touchait pas la bind
  mount `/srv/ai-stack/data/` (connectors.json, audit.jsonl, agents
  custom). Procédure documentée mise à jour pour inclure le nettoyage
  via `docker exec --user root aibox-app rm -rf /data/*`.

---

## [0.1.0] — 2026-04-30 (POC initial)

### Added
- Stack Docker Compose 28 containers (Authentik OIDC, Dify 1.10, Qdrant,
  n8n, Ollama Qwen2.5-7B + bge-m3, Open WebUI, Prometheus + Grafana + Loki,
  agents-autonomous LangGraph, mem0).
- Wizard d'installation web (`services/setup`) — questionnaire 11 chapitres,
  génération `.env` + `client_config.yaml`, déploiement non-interactif.
- Frontend Next.js 15 (services/app) : chat agents Dify, gestion users
  RGPD, audit log, /system metrics, marketplace assistants.
- Auto-provisioning SSO (Authentik OIDC clients) pour aibox-app, Open
  WebUI, Dify (admin + 4 agents par défaut + Custom Tool), n8n owner,
  Grafana admin.
- 7 connecteurs : Pennylane, FEC, Odoo, GLPI, rag-smb, rag-msgraph,
  rag-gdrive, text2sql.
