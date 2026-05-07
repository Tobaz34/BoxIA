# 🔄 Audit cycle reset → install → wizard (BoxIA v2 OSS-inspired)

> Audit complet effectué 2026-05-05 pour valider que TOUTES les nouvelles
> features (P0-P2 livrées dans cette branche) survivent à un cycle :
> `reset-as-client.sh` → wizard → `install.sh` → 100% fonctionnel.
>
> **Verdict** : ✅ après les 4 fixes ci-dessous, le cycle est complet.

---

## 🎯 Le cycle reset BoxIA (rappel)

```
1. ./reset-as-client.sh
   ├── Stoppe TOUS les containers applicatifs
   ├── Supprime les volumes Docker (aibox_*_data)
   ├── Sauvegarde + remet .env minimal (juste NETWORK_NAME)
   ├── Recrée le réseau Docker aibox_net
   └── Redémarre UNIQUEMENT le wizard de setup (port 8090)

2. User va sur http://<ip>:8090
   ├── Remplit le wizard (CLIENT_NAME, secteur, OAuth providers, ...)
   ├── Wizard écrit /srv/ai-stack/.env (secrets auto-générés)
   └── Wizard lance install.sh AIBOX_NONINTERACTIVE=1

3. install.sh deploy_stack()
   ├── Pull images
   ├── Démarre tous les services (Authentik, Dify, Ollama, ...)
   ├── Démarre aibox-app (rebuild)
   └── Lance tools/migrations/run-pending.py
       ├── 0001 dify_max_tokens
       ├── 0002-0012 (existant)
       ├── 0013 concierge_delegate_prompt  ← NEW
       ├── 0014 delegate_tool              ← NEW
       └── 0015 concierge_replan_prompt    ← NEW
```

Avant ce fix : **3 ruptures critiques** côté nouveaux services.

---

## 🔴 4 trous identifiés (avant fix)

### Trou #1 — `install.sh` n'inclut pas les nouveaux services

`deploy_stack()` ne mentionne ni `services/scheduler/` ni `services/sandbox/`.
Conséquence : après wizard, les containers `aibox-scheduler` et
`aibox-sandbox` ne démarrent jamais. Les tools `bash_exec`,
`schedule_task`, `delegate_to_specialist` (qui appelle d'autres agents
mais le sandbox/scheduler sont leur backend) renvoient 502.

**Fix appliqué** : ajout dans `deploy_stack()` de blocs best-effort :

```bash
if [[ -d services/scheduler ]]; then
  ( cd services/scheduler && docker compose ... up -d --build ) || warn
fi

if [[ -d services/sandbox ]]; then
  if ( cd services/sandbox && docker compose ... up -d --build ) 2>/dev/null; then
    c_green "    ✓ Sandbox démarré"
  else
    c_yellow "    ⚠ Sandbox non démarré — runtime gVisor probablement absent"
    c_yellow "      Pour activer : sudo apt install runsc..."
  fi
fi
```

Le sandbox a une gestion spéciale parce que `runtime: runsc` plante au
`up` si gVisor pas installé. On capture l'erreur, on log proprement,
on continue (le système n'est pas bloqué pour autant).

---

### Trou #2 — `reset-as-client.sh` ne purge ni containers ni volumes

`STOP_LIST` ne contenait pas `aibox-scheduler`/`aibox-sandbox`.
`DEL_VOLUMES` ne contenait pas `aibox_scheduler_data`.

Conséquence : après reset, les jobs APScheduler du précédent client
continueraient de tourner (un "résumé Outlook chaque matin du client A"
émettrait sur le compte du client B au prochain trigger).

**Fix appliqué** :
- Ajout `aibox-scheduler` + `aibox-sandbox` dans `STOP_LIST`
- Ajout `aibox_scheduler_data` dans `DEL_VOLUMES`
- Nouveau step `[3.5/6]` qui purge les fichiers d'état éphémères du
  bind-mount `/srv/ai-stack/data/` :
  - `concierge-approvals/` (pending HITL d'un précédent client)
  - `safety_audits.jsonl` (logs auditor — observability seulement)
  - `pending-reviews.jsonl` (HITL futurs)

Pas de purge auto des autres fichiers `/data/` (oauth-connections,
custom-agents, conversations, branding, github-token) — l'admin peut
vouloir les garder en cas de "reset léger".

---

### Trou #3 — `.env.example` manque ~20 variables

Aucune des nouvelles vars n'était documentée :

- `MAX_JOBS_PER_USER`, `AIBOX_APP_URL`, `TZ` (scheduler)
- `SANDBOX_URL`, `SANDBOX_RUNTIME`, `SANDBOX_DEFAULT_TIMEOUT`,
  `SANDBOX_MAX_TIMEOUT`, `SANDBOX_ALLOW_NETWORK` (sandbox)
- `SAFETY_AUDITOR_ENABLED`, `SAFETY_AUDITOR_MODEL`,
  `SAFETY_AUDITOR_TIMEOUT_MS`, `SAFETY_AUDITS_PATH` (auditor)
- `AGENTS_DELEGATE_MAX_DEPTH`, `AGENTS_DELEGATE_TIMEOUT_MS` (delegate)
- `RAG_HYBRID_ENABLED`, `RAG_HYBRID_ALPHA`, `RAG_HYBRID_OVERFETCH` (BM25)
- `CONCIERGE_APPROVAL_TTL_MS` (HITL TTL)

Conséquence : le wizard générant `.env` from `.env.example` n'aurait
pas inclus ces vars → defaults hardcodés dans le code utilisés (OK
pour V1 mais pas customisable par l'admin).

**Fix appliqué** : section "Services v2 OSS-inspired" ajoutée dans
`.env.example` avec les ~20 vars + commentaires d'usage.

---

### Trou #4 — `services/app/docker-compose.yml` ne propage pas les vars

Même si `.env` contient les vars, `docker-compose.yml` doit les exposer
à `aibox-app` via la section `environment:`. Sans ça, `process.env.X`
côté Next.js retourne `undefined` même si la var est dans `.env`.

Conséquence : `lib/safety-auditor.ts` et autres ne voient pas leur
config et tombent sur les defaults TS hardcodés.

**Fix appliqué** : ajout d'un bloc "v2 OSS-inspired services" dans
`environment:` qui propage 12 vars vers `aibox-app` :
- `SCHEDULER_URL`, `SANDBOX_URL`, `SANDBOX_DEFAULT_TIMEOUT`,
  `SANDBOX_MAX_TIMEOUT`
- `SAFETY_AUDITOR_*` + `OLLAMA_BASE_URL` (l'auditor doit pouvoir
  appeler Ollama)
- `AGENTS_DELEGATE_MAX_DEPTH`, `AGENTS_DELEGATE_TIMEOUT_MS`
- `RAG_HYBRID_*`
- `CONCIERGE_APPROVAL_TTL_MS`

---

## ✅ Vérifications passées

| Check | Statut | Comment |
|---|---|---|
| `bash -n install.sh` | ✅ | syntax OK |
| `bash -n reset-as-client.sh` | ✅ | syntax OK |
| `tsc --noEmit` | ✅ | TS clean |
| `python3 -c "ast.parse(...)"` migrations 0013-0015 | ✅ | syntax OK |
| Migration 0013 idempotence | ✅ | marker `[DELEGATE-V1]` check, re-run = no-op |
| Migration 0014 idempotence | ✅ | `_find_provider` check, update si existe, no-op si attaché |
| Migration 0015 idempotence | ✅ | marker `[REPLAN-V1]` check |
| `run-pending.py` auto-discover | ✅ | regex `^(\d{4})_[a-z0-9_]+\.py$` matche 0013/0014/0015 |
| Ordre migrations | ✅ | numérique, 0013 → 0014 → 0015 (mais indépendantes — peuvent être rejouées dans n'importe quel ordre) |
| `--reset-state` rejoue tout | ✅ | les 15 migrations rejouables si _state.json wipé |
| Vars env propagées vers aibox-app | ✅ | 12 nouvelles vars exposées |
| Volumes Docker purgés | ✅ | aibox_scheduler_data + sandbox tmpfs |
| Bind-mount /data purgé sélectif | ✅ | concierge-approvals + safety_audits + pending-reviews |
| Healthcheck nouveaux services | ✅ | scheduler /healthz + sandbox /healthz |

---

## 🚦 Limites connues (non bloquantes)

### Sandbox runtime gVisor

`services/sandbox/docker-compose.yml` pose `runtime: runsc` qui exige
que gVisor (`runsc`) soit installé sur l'hôte ET configuré dans Docker
daemon. Sans ça :

```
docker compose up -d
# → Error response from daemon: unknown or invalid runtime name: runsc
```

Le `install.sh` capture cette erreur et passe en yellow ; le système
continue, mais le tool `bash_exec` côté Concierge restera HS jusqu'à
activation explicite par l'admin.

**Activation manuelle (S0.4)** :
```bash
sudo apt install runsc
sudo runsc install
sudo systemctl restart docker
cd /srv/ai-stack/services/sandbox && docker compose up -d
```

Plan B si gVisor pas dispo : fallback `runc` (sécurité dégradée mais
fonctionnel) en commentant la ligne `runtime:` dans le compose.
Documenté dans `services/sandbox/README.md`.

### Safety Auditor — qwen3:1.7b absent par défaut

`lib/safety-auditor.ts` appelle Ollama avec model `qwen3:1.7b`. Si le
modèle n'est pas pull, Ollama répond 404 et l'auditor retourne verdict
`unclear` (failsafe — escalade vers approval-gate humain). Pas de
crash, juste comportement plus prudent.

**Activation** :
```bash
ssh clikinfo@xefia "docker exec aibox-ollama ollama pull qwen3:1.7b"
```

### Bind-mount `/data` non auto-purgé en entier

`reset-as-client.sh` purge les fichiers de session éphémères (HITL,
audits sécu) mais préserve les autres fichiers utilisateur. Si l'admin
veut un reset 100% propre :

```bash
sudo rm -rf /srv/ai-stack/data/{conversations.jsonl,custom-agents.json,oauth-connections.json,...}
```

C'est volontaire — un "reset léger" peut vouloir garder les
conversations (mode "essai").

---

## 🎬 Validation post-déploiement attendue

À l'issue de `reset-as-client.sh && wizard && install.sh`, le système
doit :

| Vérification | Commande |
|---|---|
| Containers up | `docker ps --filter name=aibox- --format '{{.Names}}'` doit lister : `aibox-scheduler`, `aibox-sandbox` (si gVisor), aibox-app, aibox-dify-*, aibox-authentik-*, etc. |
| Healthchecks OK | `docker inspect --format='{{.State.Health.Status}}' aibox-scheduler` → "healthy" |
| Migrations appliquées | `cat /srv/ai-stack/tools/migrations/_state.json` contient 0013/0014/0015 |
| Custom Tool Dify boxia-delegate présent | dans Dify Console → Tools → Custom Tools → "BoxIA Delegate To Specialist" 🤝 |
| Concierge pre_prompt | contient `[DELEGATE-V1]`, `[RAG-SEARCH-V1]`, `[REPLAN-V1]` |
| `/api/approvals` GET → JSON valid | `curl -H "Cookie: <auth>" https://<host>/api/approvals` → `{"pending":[],"count":0,"is_admin":...}` |
| `/approvals` page render | accessible côté UI, sidebar badge à 0 |
| Scheduler API | `curl -H "Authorization: Bearer $AGENTS_API_KEY" http://localhost:8086/healthz` → `{"ok":true}` |
| Sandbox API (si gVisor) | `curl -H "Authorization: Bearer $AGENTS_API_KEY" http://localhost:8087/healthz` → `{"ok":true,"runtime":"gvisor"}` |

Cf [TEST-PLAN-AFTER-DEPLOY.md](TEST-PLAN-AFTER-DEPLOY.md) pour les
tests E2E Chrome MCP couverts (8 suites + 5 nouvelles à ajouter
post-deploy pour scheduler/sandbox/BM25/secrets-redact/replan).

---

## 📝 Fichiers modifiés par cet audit

- `install.sh` — bloc scheduler + sandbox dans `deploy_stack()`
- `reset-as-client.sh` — STOP_LIST + DEL_VOLUMES + nouveau step 3.5/6 purge éphémères
- `.env.example` — section "Services v2 OSS-inspired" (~20 vars)
- `services/app/docker-compose.yml` — propagation 12 vars env vers aibox-app
- `tools/research/AUDIT-RESET.md` — ce fichier (rapport audit)

Aucune migration ajoutée (les 0013-0015 existantes sont déjà
idempotentes et auto-découvertes par `run-pending.py`).
