# BoxIA — Critères "produit fini" + procédure reset

> Document de référence pour valider qu'une nouvelle installation client se
> déroule sans intervention humaine, et pour préparer le test de reset
> complet sur xefia.

## 1. Critères "produit fini"

Le produit est considéré déployable chez un client TPE/PME quand TOUS ces
points sont validés sur un fresh deploy :

### 1.1 Wizard initial (zéro intervention humaine)

- [ ] L'admin saisit uniquement : nom client, secteur, nb users, email admin,
      domaine, choix techs cochées.
- [ ] Aucun mot de passe à saisir manuellement (default `aibox-changeme2026`
      proposé, banner self-healing pour rappel).
- [ ] Aucune clé API à coller (toutes auto-générées par `install.sh`).
- [ ] Le déploiement complet (pull images + boot + provisioning) prend
      ≤ 30 min sur connexion ADSL standard (le retry Authentik est plafonné
      à 30 min, cf. `services/setup/app/main.py:create_admin_user`).

### 1.2 Auto-provisioning (provision-sso)

Validés au tour d'audit (cf. `boxia_session_2026-05-01_full_day.md`) :

- [x] Authentik : compte admin (groupe `authentik Admins`)
- [x] Authentik : groupes `aibox-admin / aibox-manager / aibox-employee`
- [x] aibox-app : OIDC client + redirect_uri auto
- [x] Open WebUI : OIDC client + 1er user auto-créé au login OIDC
- [x] Dify : compte admin + workspace + 4 agents par défaut + Custom Tool « AI Box Agents »
- [x] n8n : owner account (mot de passe fort `N8N_PASSWORD` auto-généré)
- [x] n8n : 2 workflows marketplace `default_active: true` importés ET activés
      (Healthcheck stack + Snapshot Qdrant)
- [x] Portainer : admin account
- [x] Grafana : admin account (env vars) + dashboards provisionnés

### 1.3 UX unifiée

- [x] Toutes les actions courantes accessibles depuis aibox-app (pas besoin
      d'ouvrir Dify/n8n/Portainer pour le quotidien)
- [x] SSO seamless : un click sur « Ouvrir n8n / Dify / Portainer / Grafana »
      depuis aibox-app → page cible déjà connectée (cf. `/api/sso/[service]`)
- [x] Marketplace IA (Dify Explorer) : install templates en 1 clic
- [x] Marketplace n8n : install workflows en 1 clic
- [x] Notification creds manquants : banner si workflow actif a
      `credentials_required` non configurés

### 1.4 i18n

- [x] FR par défaut, EN sélectionnable dans /settings (LanguageCard)
- [x] Cookie `aibox_locale` persistant (1 an), détection navigator au 1er load
- [x] Dict typé : ajouter une clé en FR oblige à la rajouter en EN (TS check)
- [ ] (Backlog) Composants restants à i18n : AgentsManager, AuditPage,
      MePage, ConnectorsManager descriptions, etc.

### 1.5 Robustesse

- [x] n8n container healthy (fix IPv6 → 127.0.0.1)
- [x] Banner mdp self-healing (auto-clear si password_change_date > date_joined)
- [x] /api/workflows/marketplace cross-check par nom interne du JSON
- [x] createWorkflow / activate fallback PATCH → POST pour rétro-compat n8n
- [x] template_importer envoie `email` + `emailOrLdapLoginId` pour login
      n8n compat 1.70+

### 1.6 Pages quality

- [x] /, /agents, /agents/marketplace, /workflows, /workflows/marketplace
- [x] /users, /connectors, /integrations/mcp
- [x] /audit (avec labels pour toutes les nouvelles actions)
- [x] /system, /settings, /me, /help, /documents
- Aucune page ne renvoie de 500 ni n'affiche de TODO/placeholder

## 2. Hors scope (backlog assumé)

- Multi-tenant Dify pour tier `pme-plus` (3-5 jours, attendre client multi-site)
- Connecteurs HubSpot, 3CX (templates de connecteurs à compléter)
- Connecteurs Sage / EBP (pièges juridiques documentés dans
  `connectors_research_2026-05-01.md`)
- Tests E2E Playwright (backend Python a 60/60)
- Site marketing / landing page produit

## 3. Procédure reset (test complet à zéro)

### 3.1 Pré-reset : sauvegarde

```bash
ssh clikinfo@192.168.15.210 'cd /srv/ai-stack && tar czf /tmp/aibox-backup-pre-reset-$(date +%Y%m%d-%H%M).tar.gz \
  .env client_config.yaml data/'
```

### 3.2 Reset depuis l'UI

1. Se connecter à aibox-app en admin
2. Cliquer sur le badge "Configuré" en haut à droite (page setup wizard)
3. Bouton "Reset complet" → entrer `RESET` + mot de passe admin
4. Le wizard arrête + supprime les containers + nettoie .env

### 3.3 Reset CLI alternatif

```bash
ssh clikinfo@192.168.15.210 'cd /srv/ai-stack && \
  docker compose -f services/app/docker-compose.yml down -v && \
  docker compose -f services/n8n/docker-compose.yml down -v && \
  docker compose -f services/dify/docker-compose.yml down -v && \
  docker compose -f services/authentik/docker-compose.yml down -v && \
  docker compose -f services/monitoring/docker-compose.yml down -v && \
  docker compose -f services/agents-autonomous/docker-compose.yml down -v && \
  docker compose -f services/memory/docker-compose.yml down -v && \
  docker compose down -v && \
  rm -f .env client_config.yaml /var/lib/aibox/.configured'
```

### 3.4 Validation après fresh deploy

Checklist live à exécuter dans Chrome après le re-déploiement :

| Étape | URL / commande | Résultat attendu |
|-------|----------------|------------------|
| Wizard accessible | http://IP/ | Page wizard étape 1/4 |
| Configure | wizard 4 étapes | Redirection vers déploiement |
| Logs déploiement | `/api/deploy/logs` (WebSocket) | `✓ Authentik : compte créé` (tentative ≤ 5) |
| Provision SSO | logs | `✓ aibox-app, dify, dify_agent, dify_agents_tool, ak_management, n8n, portainer` |
| Import templates | logs | `✓ marketplace n8n : Healthcheck (activé)` + `✓ marketplace n8n : Snapshot Qdrant (activé)` |
| Hand-off | wizard fin | Bascule vers aibox-app au login OIDC |
| Login admin | aibox-app | Page d'accueil chargée, sidebar FR |
| /system | menu | 10/10 services healthy |
| /workflows | menu | 2 workflows actifs (les marketplace defaults) |
| /workflows/marketplace | menu | 9 disponibles, 2 installés · 2 actifs |
| /agents | menu | 4+ assistants disponibles |
| SSO Dify / n8n | bouton "Ouvrir" | Auto-login fonctionnel |
| /settings → English | toggle | Sidebar bascule en EN |

### 3.5 Si une étape échoue

- **Authentik pas ready après 30 min** : `docker logs aibox-authentik-server`
  → vérifier les pull d'images. Réseau ADSL trop lent ?
- **Marketplace n8n vide ou non actif** : check
  `docker logs aibox-setup-api` pour le rapport
  `n8n_marketplace_defaults`. Si la fonction renvoie `error: catalog not
  found`, le bind mount `/templates` est cassé.
- **SSO Dify renvoie 502** : `docker logs aibox-dify-nginx`. Souvent un
  timing : retry après 30s.

## 4. Commits qui ont rendu ça possible

Sprint « produit fini » (2026-05-01) :

1. `0cb9e1e` — feat(marketplace n8n): catalogue + UI + auto-import
2. `0df5da6` — fix(P0): n8n healthcheck IPv4 + banner self-healing + activate PATCH + retry Authentik
3. `797e8b7` — feat(P1+i18n): credentials banner + Uptime Kuma retiré + archi i18n FR/EN
4. `cd3cdc4` — feat(i18n): étend traductions à PasswordChangeBanner + /workflows/marketplace
