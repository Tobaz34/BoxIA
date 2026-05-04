# Plan d'action nuit 2026-05-04 → 2026-05-05

> Plan que je suis en autonomie pendant que le user dort. Démarrage 16h00,
> retour user prévu ~2h00, soit ~10h. Décisions tranchées par défaut, je
> ne réveille personne. Si bloqué >30 min sur une étape : skip + note TODO.

## État de départ (commit `4014ebb`, v0.2.2)

✅ Fait dans la journée :
- OAuth OIDC backend complet (Google + Microsoft)
- Domaine `demo.ialocal.pro` HTTPS via Cloudflare Tunnel
- Self-update UI + watcher systemd user-level
- GitHub auth (master Tobaz34, PAT chiffré)
- `rag-gdrive` + `rag-msgraph` workers patchés en mode OAuth (code seulement, pas démarrés)
- Endpoint `/api/oauth/internal/token` opérationnel
- 17 commits pushed sur `main` aujourd'hui

⏳ À faire cette nuit (priorité décroissante, scope ajusté à la durée).

## Rules of engagement

- **Commit + push après chaque sous-étape** (granularité fine, ~ toutes les 15-30 min). Le user au matin peut faire `git log` et voir la progression.
- **Smoke test après chaque deploy xefia** (HTTP 307 sur /). Si fail 2× consecutif → rollback + note + passe à autre chose.
- **Update mémoire au fil de l'eau** dans `memory/sprint_self_update_oauth_2026-05-03.md` (le sprint courant). Pas un nouveau fichier — on garde la mémoire dense.
- **Hooks CLAUDE.md respectés** : pas de mutation directe `/srv/ai-stack/`, tout passe par `tools/deploy-to-xefia.sh`.
- **Sudo** : seulement les commandes dans `/etc/sudoers.d/aibox-claude` (cf `memory/xefia_sudo_setup.md`). Hors whitelist → note TODO et passe.
- **Modifications Google Cloud / Microsoft Entra** : ne pas y retourner cette nuit (déjà fait, scope clos). Si besoin d'un ajustement → note TODO pour le matin.
- **Pas de modification destructive** : pas de `git reset --hard` sur main, pas de force-push, pas de `rm -rf /data`, pas de `docker volume prune`.
- **Build cassé** : si npm build échoue 2× → rollback au commit précédent et investigate. Ne pas pousser un build cassé.
- **Mode économe** : préférer des patches additifs (mode opt-in) plutôt que des refactors.

## Phase 1 — Démarrer rag-gdrive + valider sync end-to-end (priorité ★★★, ~2h)

**Pourquoi en premier** : c'est la concrétisation du travail OAuth de la journée. Sans worker démarré, OAuth Google n'apporte aucune valeur visible utilisateur.

### Étapes

1. **Build l'image rag-gdrive** sur xefia
   - `ssh clikinfo@xefia 'cd /srv/ai-stack/services/connectors/rag-gdrive && docker compose --env-file ../../../.env build'`
   - Note : `docker compose build` est dans la whitelist du hook ? À vérifier — si bloqué, alternative : ajouter une cible au `tools/deploy-to-xefia.sh` ou créer un `tools/start-connector.sh <slug>` script dédié.
   - Si build échoue (probable : `unstructured` lourd, peut prendre 10 min) → patience.

2. **Démarrer le worker en mode OAuth**
   - Vars requises côté `.env` : `OAUTH_API_BASE=http://192.168.15.210:3100` (host network), `CONNECTOR_INTERNAL_TOKEN=<existant>`, `OAUTH_CONNECTOR_SLUG_GDRIVE=google-drive`, `TENANT_ID=demo` (premier client), `QDRANT_API_KEY=<existant>`.
   - Vérifier la connectivité worker → /api/oauth/internal/token avant le 1er sync.

3. **Premier sync**
   - Le worker tente de fetch les fichiers de mon Drive perso `clikinfo34@gmail.com`.
   - Vérifier les logs : `docker logs aibox-conn-rag-gdrive`.
   - Vérifier Qdrant : `curl http://localhost:6333/collections/rag_gdrive_demo` → count points.

4. **Si sync OK** : créer un dataset Dify Knowledge sur cette collection
   - Dify a une API `POST /console/api/datasets/external_knowledge_data` ou `/datasets` pour créer un dataset external (pointing à Qdrant).
   - Plus simple : créer manuellement via l'UI Dify la 1ère fois (si pas trop long), automatiser ensuite.
   - **Skip si trop complexe** : note TODO, le user pourra créer dataset manuellement demain.

5. **Test chat** : envoyer "Quels sont les documents que tu vois dans mon Drive ?" à l'Assistant général via demo.ialocal.pro/discuter. Vérifier qu'il cite des fichiers réels.

### Critères de succès Phase 1

- ✅ Container `aibox-conn-rag-gdrive` running
- ✅ Logs : "synced N files, M chunks indexed"
- ✅ Qdrant collection `rag_gdrive_demo` non vide
- ✅ (Bonus) Dataset Dify créé + attaché à un agent + chat de test concluant

### Si bloqué sur une étape (>30 min)

- Build cassé (deps Python lourds) : skip, note TODO build
- Permission Drive (test user pas accepté) : skip, note "user à re-tester"
- Qdrant connection error : check le réseau docker (ollama_net vs aibox-net)
- Dify API : skip, manualisation possible demain

## Phase 2 — Démarrer rag-msgraph (Microsoft OneDrive) (priorité ★★, ~1h)

Pareil que Phase 1 mais pour le worker `rag-msgraph` en mode OAuth.

⚠️ Pré-requis : avoir un compte Microsoft connecté côté UI (le user a dit "déjà connecté" tout à l'heure, à vérifier). Si pas connecté → skip et note TODO.

## Phase 3 — UI sync button + status sur /connectors/<slug> (priorité ★★, ~1h)

**Pourquoi** : pour que l'admin voit l'état du sync sans aller en SSH.

### Implémentation

1. **Endpoint `/api/connectors/<slug>/status`** : retourne `{ connected, last_sync_at, items_indexed, errors? }` lu depuis Qdrant + state file du worker.
2. **Endpoint `/api/connectors/<slug>/sync-now`** : déclenche un sync immédiat. Implem : écrire un flag `/data/.sync-requested-<slug>` que le worker poll (modif worker à faire) OU `docker restart aibox-conn-rag-<slug>` (plus simple, force le worker à re-tourner).
3. **Composant `<ConnectorSyncStatus />`** : affiche stats + bouton "Synchroniser maintenant" + spinner pendant la sync. Intégré dans la modal Connecteur (ConnectorsManager.tsx) au-dessus du form.

### Critères de succès Phase 3

- ✅ Stats visibles dans modal `/connectors/google-drive` après sync
- ✅ Bouton "Synchroniser maintenant" déclenche un sync, spinner pendant, retour à statut OK

## Phase 4 — email-msgraph + calendar workers en mode OAuth (priorité ★, ~1h)

Patch additif identique à rag-msgraph (cf commit `95830e2`) :
- `AUTH_MODE=oauth` switcher
- `OAuthTokenSource(provider="microsoft", connector_slug="outlook-graph"|"outlook-calendar")`
- Compose vars updated

**Skip si Phase 1+2+3 ont pris plus que prévu** — c'est un follow-up cohérent.

## Phase 5 — Tools Gmail / Outlook / Calendar via Custom Tool Dify (priorité ★, ~2h)

Pour que les agents Dify puissent consommer ces services dynamiquement (vs RAG indexation).

### Endpoints à créer (Next.js)

- `POST /api/connectors-tools/gmail/read_inbox` : `{filter?, limit?}` → derniers emails
- `POST /api/connectors-tools/gmail/summarize_thread` : `{thread_id}` → résumé via Dify
- `POST /api/connectors-tools/outlook-mail/*` : pareil côté Microsoft
- `POST /api/connectors-tools/calendar/today` : événements du jour
- `POST /api/connectors-tools/calendar/find_free_slot` : `{duration_minutes}` → propositions
- `POST /api/connectors-tools/calendar/create_event` : `{title, start, end, attendees?}` → event créé

Tous en Bearer auth via `AGENTS_API_KEY` (pattern existant), consommant `OAuthTokenSource` côté Next.js.

### Wiring Dify

Custom Tool "Gmail Tools", "Calendar Tools" via OpenAPI schema, attaché aux agents `Tri emails` + Concierge + Assistant général.

**Skip si fatigue / complexité** — c'est riche, je peux faire 1 endpoint pour montrer le pattern et noter le reste TODO.

## Phase 6 — install.sh one-shot integration (priorité ★, ~1h)

Patch `install.sh` pour qu'un client final puisse provisionner sa box sans intervention manuelle :

- Section "DOMAIN HTTPS" : prompt subdomain (default `<hostname>.ialocal.pro`) + Cloudflare API token (master Tobaz34 fourni dans le wizard ou pré-rempli par env). Création tunnel via API CF + DNS record + config locale cloudflared + service systemd.
- Section "OAUTH PROVIDERS" : prompts Google client_id/secret + Microsoft client_id/secret. Skippable pour démarrer en mode "OAuth pas encore configuré".
- Section "SUDOERS" : depose `/etc/sudoers.d/aibox-claude` (cf `memory/xefia_sudo_setup.md`).
- Section "UPDATE WATCHER" : install + enable `aibox-update-watcher.service`.
- Section "AUTHENTIK PATCH REDIRECT URI" : ajoute auto `https://<subdomain>/api/auth/callback/authentik` à la whitelist.
- Section "CONNECTOR SECRET" : génère `CONNECTOR_INTERNAL_TOKEN` random.

## Phase 7 — Mémoire + récap final + commit final (~15 min)

Avant que le user revienne :
- Update `memory/sprint_self_update_oauth_2026-05-03.md` avec ce qui a été fait cette nuit
- Création `memory/night_session_2026-05-04.md` avec le récap clair (commits, ce qui marche, ce qui reste TODO, blockers rencontrés)
- Commit final `night summary` + push

## Liste de TODOs explicites pour le matin (peut-être je n'aurai pas tout fait)

À synchroniser dans `memory/sprint_self_update_oauth_2026-05-03.md` :
- Privacy Policy / ToS / homepage `ialocal.pro` pour la verification Google (chemin critique le plus long, ~2-6 semaines)
- Verification Microsoft Publisher (multi-tenant warning observé)
- Tester le flow OAuth Microsoft user-level depuis demo.ialocal.pro (le user a dit "déjà connecté" mais à confirmer côté `/data/oauth-connections.json`)
- Bench réel post-OAuth : "Mon assistant peut-il vraiment trouver mes docs Google ?"

## Limites strictes (NE PAS FAIRE en autonomie cette nuit)

- ❌ Modification Google Cloud Console / Microsoft Entra (déjà bouclé)
- ❌ Création nouveaux comptes Google / Microsoft / autre service externe
- ❌ Achat de domaines, services, plans payants
- ❌ Send emails à des humains via Gmail/Outlook
- ❌ Push vers d'autres repos GitHub que `Tobaz34/BoxIA` (rien à toucher ailleurs)
- ❌ Modification CLAUDE.md / hooks / safety rules
- ❌ `git reset --hard origin/main` ou autre destructif sur main
- ❌ Force-push
- ❌ Suppression de données (`rm -rf`, `docker volume prune`, `psql DELETE`)
- ❌ Fermer / désactiver le watcher `aibox-update-watcher`
- ❌ Toucher aux apps Dify existantes en DB sans migration versionnée

## Checkpoints commit log attendu (au matin)

Si tout va bien :
- `feat(connector): démarrage rag-gdrive en mode OAuth`
- `feat(connector): démarrage rag-msgraph en mode OAuth`
- `feat(api): /api/connectors/<slug>/status + sync-now`
- `feat(ui): ConnectorSyncStatus component`
- `feat(workers): email-msgraph + calendar AUTH_MODE=oauth`
- `feat(tools): endpoints Gmail / Calendar pour Custom Tool Dify`
- `feat(install): wizard subdomain + cloudflared auto-provision`
- `docs(memory): night session 2026-05-04 récap`

Si une phase doit être skippée, le commit le note.

---

Plan validé et lisible. Je le commit puis je commence Phase 1.
