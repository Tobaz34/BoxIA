# Architecture — AI Box Hermes-first

> ADR du **2026-06-14**. Pivot : Hermes Agent (Nous Research, MIT) devient le socle produit ; le moat BoxIA (connecteurs FR, RGPD, multi-tenant, branding) se greffe par config + extensions externes, **sans forker le cœur Hermes**.

## 1. Décisions

| # | Sujet | Décision |
|---|---|---|
| D1 | Socle | **Hermes Agent**, installé vierge (`pip`/clone), jamais modifié dans ses entrailles. MAJ via `hermes update`. |
| D2 | Connecteurs | Exposés en **serveurs MCP** (`mcp_servers:` config), chacun un shim qui proxy le microservice FastAPI existant. **aibox-app sort du chemin runtime.** |
| D3 | Sécurité tools | **Hooks Hermes** : `pre_tool_call` pour l'approval-gate (anti prompt-injection), `pre_api_request` pour le scrub RGPD avant envoi cloud. |
| D4 | LLM | **IA locale par défaut** (Ollama, `provider: custom`). Fallback cloud (Claude Haiku BYOK) pour la latence messagerie, via `hermes fallback`. Scrub RGPD obligatoire avant tout appel cloud. |
| D5 | Multi-utilisateur | **1 instance Hermes par entreprise** (`HERMES_HOME` dédié). N employés isolés via `group_sessions_per_user: true` + pairing Telegram. |
| D6 | Branding | `display.skin` custom (`agent_name: AI Box`) + `SOUL.md` personnalisable par tenant. |
| D7 | Admin | Pas de gros front Next.js. Admin = fichiers de config versionnés + provisioning scripté. Un mini-dashboard viendra plus tard si besoin (Hermes a déjà `hermes dashboard`). |

## 2. Flux runtime cible

```
Employé (Telegram / WhatsApp / Web)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Hermes Agent  (1 instance / entreprise)     │
│  HERMES_HOME=/data/tenants/<slug>            │
│                                              │
│  model: Ollama local  ──fallback──▶ cloud    │
│                                              │
│  hooks:                                      │
│    pre_tool_call   → approval_gate.sh  ──────┼──▶ bloque les tools mutatifs
│    pre_api_request → rgpd_scrub.sh     ──────┼──▶ caviarde PII avant cloud
│                                              │
│  mcp_servers:                                │
│    pennylane → shim ──▶ FastAPI Pennylane    │
│    odoo      → shim ──▶ FastAPI Odoo         │
│    glpi/fec/…                                 │
│                                              │
│  skills.external_dirs: aibox-hermes/skills/  │
│  display.skin: aibox  (branding)             │
└─────────────────────────────────────────────┘
```

**Ce qui disparaît du runtime vs l'ancienne BoxIA** : Dify (moteur d'agent), le chat UI Next.js, la synchro multi-DB, les endpoints `/api/agent/*` jamais codés. Les microservices connecteurs FastAPI **restent** (réutilisés tels quels derrière les shims MCP).

## 3. Points d'extension Hermes (vérifiés dans le code)

Source : `.research-cache/hermes-agent/cli-config.yaml.example` + `gateway/hooks.py` + `optional-mcps/`.

### 3.1 MCP servers — connecteurs
```yaml
mcp_servers:
  pennylane:
    command: "${TENANT_DIR}/mcp-connectors/pennylane/.venv/bin/python"
    args: ["${TENANT_DIR}/mcp-connectors/pennylane/server.py"]
    env:
      PENNYLANE_TOOL_BASE_URL: "http://127.0.0.1:8081"   # le FastAPI existant
      PENNYLANE_TOOL_API_KEY: "${env:PENNYLANE_TOOL_API_KEY}"
    timeout: 60
```
Stdio **ou** HTTP (`url:` + `headers:`) — au choix selon le déploiement.

### 3.2 Plugins Python — sécurité (port du moat) ✅ POC validé

> Vérifié dans la source : seuls les **plugins** (pas les shell hooks) peuvent à la fois *bloquer* un tool et *réécrire* un résultat. `pre_api_request` est **observer-only** (utilisé par Langfuse, ne mute pas le payload). Les plugins vivent dans `${HERMES_HOME}/plugins/<name>/` et sont auto-découverts.

- **`aibox-approval`** — hook `pre_tool_call`. Bloque tout tool matchant `AIBOX_MUTATING_TOOLS_REGEX` tant qu'il n'a pas été approuvé via `/aibox-approve <id>`. Le LLM ne peut pas s'auto-approuver. Anti param-swap par hash des args (port de [approval-gate.ts](../services/app/src/lib/approval-gate.ts)).
- **`aibox-rgpd`** — hook `transform_tool_result`. Caviarde la PII FR des résultats d'outils avant le cloud quand `AIBOX_RGPD_SCRUB=1` (port de [pii-scrub.ts](../services/app/src/lib/pii-scrub.ts)).

```python
# squelette commun (cf. plugins/aibox-*/__init__.py)
def register(ctx):
    ctx.register_hook("pre_tool_call", _block_mutating_until_approved)   # aibox-approval
    ctx.register_hook("transform_tool_result", _scrub_pii)               # aibox-rgpd
```

Wire : `pre_tool_call` retourne `{"action":"block","message":...}` pour véto ; `transform_tool_result` retourne la string réécrite (ou `None`).

### 3.3 Modèle — IA locale + fallback
```yaml
model:
  provider: "custom"
  base_url: "http://127.0.0.1:11434/v1"   # Ollama local
  default: "qwen3:14b"
# fallback cloud configuré au provisioning :
#   hermes fallback add anthropic claude-haiku-4-5 --priority 1   (latence)
#   (local reste priorité 2 = repli hors-ligne / données sensibles)
```

### 3.4 Multi-utilisateur
```yaml
group_sessions_per_user: true     # isolation par employé (défaut sécurisé)
platforms:
  telegram:
    # dm_policy via gateway: allowlist | pairing
max_concurrent_sessions: null
```

## 4. Sécurité — invariants conservés de BoxIA

1. **Approval-gate non contournable** : les params exécutés viennent du *pending* enregistré au 1er appel, jamais du body de la 2e requête (anti param-swap). Repris de `services/app/src/lib/approval-gate.ts`.
2. **RGPD** : scrub PII FR (SIRET/SIREN/NIR/IBAN/CB/tél/email) avant tout envoi cloud. Repris de `services/app/src/lib/pii-scrub.ts` (ordre des patterns critique).
3. **Connecteurs read-only par défaut** (le Pennylane n'expose aucun POST/PATCH/DELETE pour l'instant).
4. **Secrets** : dans `~/.hermes/.env` du tenant, jamais en clair dans la config versionnée.

## 5. Risque & couplage

- **Dépendance Hermes** : atténuée par le découplage total (notre moat = MCP + hooks + config). Si Nous dérape, on débranche le moteur sans toucher au moat. MIT le permet.
- **Latence locale** : qwen3:14b ≈ 24-48 s sur RTX 4070 → cloud Haiku en primary pour la messagerie, local en fallback/données sensibles.
