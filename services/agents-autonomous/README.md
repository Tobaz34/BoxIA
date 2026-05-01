# 🤖 AI Box — Service Agents Autonomes

Sidecar **LangGraph** qui ajoute 3 agents "qui agissent" à la stack AI Box, sans toucher à Dify ou aux autres services.

---

## Pourquoi ce service

Dify est excellent pour le **chat + RAG + workflows simples**. Mais il n'a pas :
- Workflows long-running avec checkpointing (reprendre une tâche après crash, pause utilisateur)
- Agents stateful avec mémoire entre étapes
- Décomposition fine "1 tool par nœud" pour fiabiliser le tool-use sur LLM 7B

Ce service comble ce gap. **Il s'intègre à Dify par HTTP** (pas de remplacement).

---

## Les 3 agents

| Endpoint | Workflow | Use case TPE/PME | Latence (Qwen2.5-7B) |
|---|---|---|---|
| `POST /v1/triage-email` | classify → analyze → draft | Tri email entrant + draft réponse | ~6 s |
| `POST /v1/generate-quote` | parse → identify → price → finalize | Devis depuis brief client en langage naturel | ~18 s |
| `POST /v1/reconcile-invoice` | extract → match → assess | Rapprochement facture ↔ commande/règlement | ~24 s |

**Bench mesuré sur xefia (RTX 4070 Super, Ollama Qwen2.5-7B) : 15/15 succès (100%)**

---

## Architecture

```
[Dify Workflow]
      │
      │ HTTP POST + Bearer
      ▼
┌─────────────────────────────────┐
│  aibox-agents (FastAPI)          │
│  ┌──────────────────────────┐   │
│  │  LangGraph nodes (1 tool │   │
│  │  par nœud → fiabilité 7B)│   │
│  └──────────┬───────────────┘   │
│             │                    │
│  ┌──────────▼─────────────┐     │
│  │ Pydantic schemas avec   │     │
│  │ normalize_keys + defaults│     │
│  │ defensifs (coercion.py)  │     │
│  └──────────┬──────────────┘    │
│             │                    │
│  ┌──────────▼──────────────┐    │
│  │ llm.py — abstraction     │    │
│  │ Ollama (tpe) | vLLM (pme) │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
              │
              ▼
       [Ollama / vLLM]
```

---

## Pourquoi ça marche sur 7B local

3 patterns combinés (sans lesquels on tombe à 28% de succès sur 5 tool-calls) :

1. **Workflow figé en DAG** : pas de boucle ReAct libre. Chaque nœud a 1 schéma Pydantic strict en sortie.
2. **`normalize_keys` + `coerce_str_list`** ([utils/coercion.py](app/utils/coercion.py)) : absorbent les dérives FR/EN du LLM (`"résumé"` → `"summary"`, `[{"k":"v"}]` → `["k: v"]`, déballage de wrappers `{"output": {...}}`).
3. **Defaults Pydantic safe** : si le LLM oublie un champ, on a une valeur de fallback raisonnable (ex: `EmailAction.ARCHIVER` = no-op côté monde réel).

---

## Configuration adaptative

Le service s'adapte au profil hardware via `HW_PROFILE` (cf. [config/profiles.yaml](../../config/profiles.yaml)) :

| Profil | Backend | Modèle | Outlines | Use cases |
|---|---|---|---|---|
| `tpe` | Ollama | `qwen2.5:7b` | ❌ | 1-5 users, séquentiel, fallbacks defensifs |
| `pme` | vLLM | `Qwen2.5-14B-Instruct-AWQ` | ✅ guided_json | 5-30 users, continuous batching |
| `pme-plus` | vLLM | `Qwen2.5-32B-Instruct-AWQ` | ✅ guided_json | 30-100 users, multi-tenant |

Détection auto : `./scripts/detect-profile.sh -u 25` → suggère le profil + valide le HW.

---

## Démarrage

```bash
# 1. Variables (dans /srv/ai-stack/.env)
AGENTS_API_KEY=$(openssl rand -hex 32)
HW_PROFILE=tpe                          # ou pme / pme-plus
INFERENCE_BACKEND=ollama                # ou vllm
LLM_MAIN=qwen2.5:7b
PG_DIFY_PASSWORD=...                    # déjà présent

# 2. Build + run
cd services/agents-autonomous
docker compose --env-file ../../.env up -d --build

# 3. Healthcheck
curl http://127.0.0.1:8085/healthz
curl http://127.0.0.1:8085/v1/info
```

---

## Intégration dans Dify (étape par étape)

### Option A — Tool HTTP custom (recommandé)

1. Dans la console Dify (`http://aibox-agents.local`), aller dans **Tools → Custom → Create Custom Tool**
2. Choisir **Schema Type: OpenAPI 3** et coller :

```yaml
openapi: 3.0.0
info:
  title: AI Box Agents
  version: 0.1.0
servers:
  - url: http://aibox-agents:8000      # nom du container sur aibox_net
paths:
  /v1/triage-email:
    post:
      operationId: triageEmail
      summary: Trie un email et propose réponse + actions
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sender, subject, body, received_at]
              properties:
                sender: { type: string, format: email }
                sender_name: { type: string }
                subject: { type: string }
                body: { type: string }
                received_at: { type: string, format: date-time }
                has_attachments: { type: boolean }
      responses:
        "200":
          description: Email triage result
  /v1/generate-quote:
    post:
      operationId: generateQuote
      # ... idem
  /v1/reconcile-invoice:
    post:
      operationId: reconcileInvoice
      # ... idem
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
```

3. **Authentication: Bearer**, coller la valeur de `AGENTS_API_KEY`.
4. Tester l'outil dans Dify avec un payload exemple.
5. **Utiliser dans un Workflow** : drag-and-drop le node **Tool → AI Box Agents**, mapper les inputs depuis les variables du workflow.

### Option B — Webhook depuis n8n

Pour orchestrer "email entrant Microsoft 365 → triage → router selon décision" :

```
[n8n] Trigger Microsoft Outlook
   │
   ├── HTTP Request POST aibox-agents:8000/v1/triage-email
   │       Headers: Authorization: Bearer ${AGENTS_API_KEY}
   │
   ├── Switch sur category :
   │     - commercial + devis_a_generer → POST /v1/generate-quote
   │     - support → créer ticket GLPI
   │     - administratif → marquer dans Outlook
   │
   └── Si needs_human_validation → notification Slack pour validation
```

---

## Sécurité

- **Bind sur 127.0.0.1** : le service n'est joignable qu'en interne (`aibox_net` Docker network).
- **Bearer token** obligatoire (`AGENTS_API_KEY`).
- **Pas de stockage user data** : stateless par défaut. Le checkpointer Postgres est optionnel (à activer pour les workflows long-running).
- **Logs structurés JSON** (structlog) : intégrables dans Loki existant.
- **Mémoire bornée** : 1 Go max par container, ne dérive pas avec le temps.

---

## Métriques

Endpoint Prometheus à `/metrics` :
- `aibox_agents_requests_total{agent, status}` — compteur
- `aibox_agents_request_duration_seconds{agent}` — histogramme

À ajouter dans `services/monitoring/prometheus.yml` :

```yaml
scrape_configs:
  - job_name: aibox-agents
    static_configs:
      - targets: ["aibox-agents:8000"]
```

---

## Ce qui reste à faire (post-MVP)

- [ ] **Outlines** : activer `ENABLE_OUTLINES=true` quand vLLM déployé pour passer à 100% conformité JSON sans fallbacks
- [ ] **Checkpointer Postgres** : activer pour les workflows long-running (pause/reprise)
- [ ] **Streaming SSE** : exposer la progression nœud-par-nœud côté UI Dify
- [ ] **mem0** : ajouter mémoire long-terme par user (utilise Qdrant existant)
- [ ] **Eval framework** : LangSmith ou ragas pour mesurer la qualité des sorties dans le temps
- [ ] **Test de charge** : valider 8 users concurrents en tier `pme` (vLLM batching)

---

## Debug

Logs : `docker logs -f aibox-agents`
Variables runtime : `curl http://127.0.0.1:8085/v1/info`
Recompile sans build complet : `docker cp app/ aibox-agents:/app/ && docker restart aibox-agents`
