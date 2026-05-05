# AutoGPT — Analyse pour BoxIA

> Repo cloné : `D:\IA_TPE_PME_POWER\.research-cache\autogpt\` (master @ `bf6d644`, 2026-05-01)
> Tous les chemins ci-dessous sont relatifs à ce clone.

## Fiche d'identite

- **URL** : https://github.com/Significant-Gravitas/AutoGPT
- **Licence** : Polyform Shield (sur `autogpt_platform/`, restrictive — interdit la concurrence cloud) + MIT (sur `classic/`, anciens agents/forge/benchmark)
- **Stars** : ~180k (projet historiquement viral 2023)
- **Activité** : commits quotidiens, dernier `master` à 2026-05-01, workflow CI Claude actif (`claude-ci-failure-auto-fix.yml`)
- **Mainteneurs** : société Significant Gravitas Ltd (équipe 20+ contributeurs internes + Discord communauté large)
- **Public cible** : développeurs / power-users qui veulent construire/déployer des agents IA continus → cloud SaaS (closed beta) + self-host
- **Maturité** : `autogpt_platform/` est en bêta active (CLA exigée, Polyform Shield), backend Python prod-grade (Prisma, RabbitMQ, Redis, Sentry, Stripe), frontend Next.js 15 + TypeScript, Supabase pour Auth/DB. Le `classic/` (le AutoGPT historique de 2023) est freezé.
- **État** : la plateforme V2 est leur unique focus. Self-host technique (compose massif : Supabase/Kong/Auth/DB/Studio + Redis cluster 3 nœuds + RabbitMQ + FalkorDB + ClamAV + executor + copilot_executor + websocket + scheduler + notifications + frontend = ~20 conteneurs)

## Architecture

```
+-------------------------------------------------------------+
| FRONTEND (Next.js 15, React, TS, Tailwind, shadcn/ui)       |
| - app/(platform)/build  : agent builder visuel (xyflow)     |
| - app/(platform)/copilot: chat + tools agentiques (SSE)     |
| - app/(platform)/library/marketplace                         |
| - middleware: auth Supabase + paywall                        |
+-----^---------------------^---------------------------------+
      | REST + WebSocket    |
+-----+---------------------+---------------------------------+
| BACKEND (Python, FastAPI, Pydantic, Prisma, asyncio)        |
|                                                             |
| rest_server  - FastAPI v1, v2, external API + OAuth         |
| ws_server    - exec status push                              |
| executor     - graph-runner (RabbitMQ-driven, dry-run aware)|
| copilot_exec - chat agent (SDK Claude Agent + baseline)     |
| scheduler    - cron triggers + late-execution monitor       |
| automod      - moderation pre-exec (configurable, fail-open)|
| notification - email + push (SMTP + WebPush + tally)        |
| db_manager   - centralized DB ops (sync+async pool)          |
+-------------------------------------------------------------+
   |                |                |               |
 [Postgres]   [Redis cluster 3]  [RabbitMQ]   [FalkorDB graph]
 (Supabase    (cache + locks +    (graph        (Graphiti
  via Kong)    pubsub event bus)   exec queue)   memory)
```

Flux d'exécution typique d'un agent :
1. User compose un graph dans l'UI (`frontend/src/app/(platform)/build/`) — drag/drop de blocks
2. Frontend POST `/api/v1/graphs/{id}/execute` → `rest_server`
3. `rest_server` valide, crée `AgentGraphExecution`, publie sur RabbitMQ
4. `executor` (pool de workers) consomme, instancie `Block` chaînés, gère le **flow asynchrone par links** (`backend/data/graph.py`)
5. Pour chaque node : `_execute()` (`backend/blocks/_base.py`) → validation Pydantic → review HITL si `is_sensitive_action` → AutoMod → exécution → tracking coût
6. Outputs streamés via Redis pubsub → ws_api → UI live updates

Modules clés à connaître :
- `autogpt_platform/backend/backend/blocks/_base.py` — modèle `Block` avec `BlockSchema`/`BlockCost`/`BlockType`/HITL
- `autogpt_platform/backend/backend/executor/manager.py` (1953 lignes) — runtime d'exécution
- `autogpt_platform/backend/backend/data/graph.py` (1903 lignes) — modèle graph + library
- `autogpt_platform/backend/backend/data/credit.py` (2534 lignes) — système crédits/Stripe/refund
- `autogpt_platform/backend/backend/copilot/` — agent IA "Otto" qui crée/édite/fix des graphs via tools
- `autogpt_platform/backend/backend/sdk/` — DSL fluent pour déclarer un nouveau provider en quelques lignes

## Features remarquables

1. **Modèle Block uniforme** (`autogpt_platform/backend/backend/blocks/_base.py:482`) — chaque action est un `Block` avec `Input`/`Output` Pydantic auto-converti en JSON Schema, `categories`, `costs`, optionnellement `webhook_config`. 95+ blocks (LLM, Discord, Notion, GitHub, HubSpot, Linear, MCP, SQL, Slack, Twitter…). Modèle remarquable : un block expose son schéma au frontend qui génère le formulaire automatiquement.

2. **Graph executor distribué** (`backend/executor/manager.py`) — pool de workers Python qui consomment RabbitMQ, gestion `dry_run`, retries, cluster locks Redis, Prometheus metrics (`active_runs_gauge`, `pool_size_gauge`), ThreadPoolExecutor par worker. Production-grade.

3. **Block cost dynamique + Stripe + refund** (`backend/data/credit.py`, `backend/executor/billing.py`) — 6 types de coûts (`RUN`, `BYTE`, `SECOND`, `ITEMS`, `COST_USD`, `TOKENS`), facturation post-flight pour les types dynamiques, Stripe webhook, auto top-up, table `CreditRefundRequest` avec workflow d'approbation. Système de **subscriptions tier** (BASIC/PRO/MAX/BUSINESS/ENTERPRISE) qui multiplie les rate-limits (1x/5x/20x/60x).

4. **Provider SDK fluent** (`backend/sdk/builder.py`, `backend/sdk/provider.py`) — un nouveau service tiers se déclare avec `ProviderBuilder("github").with_oauth(GithubOAuth, scopes=[...]).with_api_key().with_base_costs([...]).build()` puis tous les blocks de ce provider héritent automatiquement du wiring credentials. Excellent ROI pour scaler le catalogue.

5. **Human-In-The-Loop natif** (`backend/data/human_review.py`, `backend/blocks/human_in_the_loop.py`, attribut `is_sensitive_action` sur tout `Block`) — table `PendingHumanReview`, statut `REVIEW`, support auto-approval par `(graph_exec_id, node_id)` et données éditables au moment de l'approbation. La review est OPT-IN par graph (`sensitive_action_safe_mode`).

6. **AutoMod** (`backend/executor/automod/manager.py`) — modération configurable des inputs avant exécution (API tierce + `fail_open`/`fail_close`), feature-flag par user. Bloque les agents qui essaient d'exécuter du contenu toxique avant que le coût soit engagé.

7. **Copilot/Otto = agent qui construit des agents** (`backend/copilot/`, ~80 fichiers) — c'est l'équivalent de notre Concierge mais avec **40+ tools** : `create_agent`, `customize_agent`, `edit_agent`, `fix_agent`, `validate_agent`, `find_block`, `run_block`, `run_mcp_tool`, `bash_exec`, `e2b_sandbox`, `web_search`, `web_fetch`, `graphiti_search`/`store`/`forget`, `manage_folders`, `connect_integration`, `todo_write`. Pipeline `fix_validate_and_save` (`copilot/tools/agent_generator/pipeline.py`) avec auto-correcteur d'agents JSON. Routing `model_router.py` qui choisit Claude Sonnet/Haiku selon le tier.

8. **Mémoire long-terme via Graphiti + FalkorDB** (`backend/copilot/graphiti/`) — knowledge graph par utilisateur (group_id dérivé du user_id, isolation propre), TTLCache LRU des clients, par event-loop. Apprend des entités/relations à partir des conversations, requêtage Cypher. Très en avance sur notre `lib/memory.ts`.

9. **Sandbox E2B + bubblewrap fallback** (`backend/copilot/tools/e2b_sandbox.py`, `backend/copilot/tools/bash_exec.py`) — chaque session du copilot a un sandbox cloud E2B persistant (paused entre tours, gratuit au repos) ou bwrap local si pas d'E2B configuré. Permet à l'agent d'exécuter des commandes bash, lire/éditer des fichiers, sans risque pour l'host.

10. **Marketplace + hybrid search** (`backend/api/features/store/`) — store d'agents avec embeddings pgvector (`UnifiedContentEmbedding`) + tsvector FTS + **BM25 reranking** (`hybrid_search.py`) — combine semantic (30% poids BM25) + lexical pour les recherches d'agents/blocks/docs. Reviews, ratings, soumissions versionnées (`StoreListingVersion`).

11. **Webhooks bidirectionnels** (`backend/integrations/webhooks/`) — modèle `BlockWebhookConfig` qui auto-provisionne les webhooks chez le provider (GitHub repo hooks, Slack, Compass, Telegram, Slant3D). Gestion des graph_lifecycle_hooks (création/suppression auto à activation/désactivation).

12. **MCP universel** (`backend/blocks/mcp/`) — un `MCPToolBlock` unique qui se connecte à n'importe quel serveur MCP, découvre dynamiquement ses tools, et expose chaque tool comme un block typé. Schéma adaptatif au runtime selon le tool sélectionné.

13. **Workspace partagé multi-execution** (`backend/data/workspace.py`, `UserWorkspaceFile`/`SharedExecutionFile`) — chaque user a un workspace de fichiers, partagé entre exécutions du même agent, accessible par les blocks. Différent de notre approche `[FILE:...]` per-exec.

14. **Streaming reasoning stripper** (`backend/copilot/thinking_stripper.py`) — gère `<thinking>`, `<internal_reasoning>`, depth counter pour tags imbriqués, robuste aux chunks coupés. Plus complet que notre `lib/strip-think.ts` (qui ne gère que `<think>` Qwen).

15. **External API + OAuth applications** (`backend/api/external/v1/`, models `OAuthApplication`, `OAuthAccessToken`, `OAuthRefreshToken`) — AutoGPT s'expose comme provider OAuth pour des intégrations tierces. APIKey table pour clés stables.

16. **Onboarding XP/points + auto-features** (`backend/data/onboarding.py`) — calcul de points par milestones (premier run, X consecutive days), détection des intégrations connectées, conversion en suggestions personnalisées dans l'UI.

17. **Email + WebPush + Tally** (`backend/notifications/`, `backend/data/push_subscription.py`) — notifications par email (templates Jinja), web push browser (VAPID), opt-in granulaire par event (run réussi, balance basse, weekly summary, agent approved).

## Comparatif avec BoxIA

| Dimension | AutoGPT | BoxIA | Verdict |
|---|---|---|---|
| Modèle agent | Block-based graph (DAG asynchrone, ~95 blocks) + Copilot Claude SDK | Dify (templates LLM) + n8n (workflows) + Concierge (10 tools) | AutoGPT plus uniforme et compositionnel ; BoxIA délègue à 2 outils tiers |
| Mémoire CT | DB Postgres `ChatMessage` | Postgres + RAG vectoriel | Comparable |
| Mémoire LT | **Graphiti + FalkorDB** (knowledge graph par user) | mem0 sidecar | AutoGPT plus puissant (graph), mem0 plus simple |
| RAG | Embeddings + pgvector + BM25 hybrid | Qdrant + Dify Knowledge | Comparable, AutoGPT a BM25 reranking en plus |
| Tool-use | Block schema Pydantic + auto JSON Schema + 95+ blocks + MCP | Dify Custom Tools + Concierge tools (10) + MCP marketplace | AutoGPT a un catalogue plus large mais cible dev ; BoxIA cible métier FR |
| UI | Next.js 15 + xyflow builder visuel + chat copilot | Next.js 15 unifié (chat+agents+connectors) | AutoGPT a un builder visuel pro, BoxIA a une UX TPE plus simple |
| Self-hosted | Compose ~20 services (Supabase + Redis cluster + RabbitMQ + FalkorDB + ClamAV…) | Compose 33 services (Authentik + Dify + n8n + Ollama + Qdrant…) | Tied — tous les deux sont lourds |
| Secrets/sandbox | E2B cloud sandbox (par session) + bwrap fallback | **Aucun sandbox** | AutoGPT clairement devant |
| Multi-user/RBAC | Subscription tiers (5x rate-limit) + Profile + Library scoping | RBAC par connecteur + tier free/pme/pme-plus | Comparable, BoxIA plus business |
| Connecteurs | OAuth Google/GitHub/Notion/Reddit/Twitter/Discord/Todoist + ~30 API key providers | Google/Microsoft/Pennylane/Odoo/HubSpot/GLPI + n8n connectors | AutoGPT US-centric, BoxIA FR-centric |
| Marketplace | Store interne avec hybrid search + reviews + paiement | Marketplaces dérivées (Dify/n8n/MCP) + boxia-fr-templates | AutoGPT a un vrai store productisé, BoxIA pas encore monétisé |
| Self-update | (rolling Docker tags) | systemd watcher OTA + bouton UI | BoxIA devant (appliance) |
| Observabilité | Sentry + Prometheus + Langfuse + Sentry traces | Langfuse v2 + audit log | Comparable, AutoGPT a Prometheus en plus |
| Paiement/billing | Stripe + crédits + 6 types coût + auto top-up + refund | BYOK plafond €/mois + audit | AutoGPT prêt pour SaaS, BoxIA pour appliance |
| Déploiement | Compose docker + setup-autogpt.sh + Supabase migrate | `tools/deploy-to-xefia.sh` + migrations versionnées + lock | Comparable, BoxIA plus rigoureux pour multi-session |
| Modèles | Multi-LLM (OpenAI/Anthropic/Gemini/xAI/Groq/Ollama) via `LlmModel` enum | Ollama qwen3:14b + qwen2.5vl + cloud BYOK | AutoGPT plus flexible, BoxIA optimisé local FR |
| Langues | Anglais (8 langues README via zdoc.app, mais UI en) | FR/EN i18n natif | BoxIA devant |
| HITL | Block `HumanInTheLoopBlock` + `is_sensitive_action` + table `PendingHumanReview` + auto-approval | `approval-gate.ts` + Concierge banner | AutoGPT plus mature et générique |
| AutoMod | Service moderation configurable pré-exec | PII scrub 7 patterns FR | Différents : AutoGPT bloque, BoxIA scrub |

## A voler tel quel

| Idée | Source AutoGPT | Cible BoxIA | Effort |
|---|---|---|---|
| **HITL générique avec table `PendingHumanReview`** + statut `REVIEW` + auto-approve key `auto_approve_{exec_id}_{node_id}` | `backend/data/human_review.py` + `backend/blocks/human_in_the_loop.py` | Étendre `lib/approval-gate.ts` qui aujourd'hui ne couvre que le Concierge → applicable aux n8n workflows et Dify agents (mutations OAuth, suppressions documents, sends mails) | M (3-5j) |
| **BM25 reranking sur RAG** (rank_bm25 + combiner avec score vectoriel) | `backend/api/features/store/hybrid_search.py:bm25_rerank` | Améliorer `lib/qdrant-client.ts` ou côté Dify Knowledge | S (1-2j) |
| **Streaming `<thinking>` stripper avec depth counter et chunk-boundary safe** | `backend/copilot/thinking_stripper.py` | `lib/strip-think.ts` (qui ne gère que `<think>` simple) | S (0.5-1j) |
| **Onboarding XP/milestones** | `backend/data/onboarding.py` | Page `/onboarding` BoxIA actuelle est statique → ajouter scoring | S (1j) |
| **`is_sensitive_action` flag sur tools/connectors** | `backend/blocks/_base.py:501` | Marquer chaque tool dans `agents-tools/*/route.ts` (`send_email`, `delete_*`, `pay_*`) → déclencher auto la HITL | S (1-2j) |
| **WebPush notifications** (VAPID + table `PushSubscription`) | `backend/data/push_subscription.py` + `backend/notifications/push_sender.py` | Tier pme-plus, pour alerter sur fin de workflow long | M (2-3j) |
| **Block lifecycle hooks (auto-provisionner webhooks à activation)** | `backend/integrations/webhooks/graph_lifecycle_hooks.py` | n8n workflows actifs ont déjà cette logique, mais pas les Concierge agents qui invoquent OAuth providers | M (2-4j) |

## A adapter

| Idée | Source AutoGPT | Adaptation BoxIA | Effort |
|---|---|---|---|
| **ProviderBuilder fluent SDK** | `backend/sdk/builder.py` + `backend/sdk/provider.py` | Refondre `lib/connectors.ts` + `lib/oauth-providers.ts` en builder TS pour qu'un nouveau connecteur FR (Cegid, Sage, EBP, Quadratus) soit 1 fichier de 30 lignes | M (3-5j, gros ROI roadmap) |
| **Knowledge graph mémoire long-terme** (Graphiti + FalkorDB) | `backend/copilot/graphiti/` | Notre mem0 fait du flat ; passer à Graphiti permet aux agents de relier "client X = SIREN Y = facture Z = relance K" | L (1-2 sem, dépend FalkorDB qui n'est pas dans la stack actuelle — alternative neo4j) |
| **MCP universel block (server URL + tool dropdown dynamique)** | `backend/blocks/mcp/block.py` | Notre `lib/mcp-marketplace.ts` est statique → ajouter un endpoint qui list les tools d'un MCP server arbitraire et expose chacun comme un Custom Tool Dify | M (3-4j) |
| **Sandbox E2B / bubblewrap pour bash_exec côté Concierge** | `backend/copilot/tools/e2b_sandbox.py` + `bash_exec.py` | Le Concierge ne peut pas exécuter de commande shell aujourd'hui ; ajouter un container `bwrap` ou e2b self-host pour des "tâches IT" (créer un PDF côté docker, manipuler un xlsx, runner un python). Pour TPE/PME : vraiment puissant ("génère-moi le tableau X depuis cette base") | L (1-2 sem) |
| **Crédits + Stripe + 6 types de coûts** | `backend/data/credit.py` + `backend/executor/billing.py` | BoxIA a "BYOK plafond €/mois" — passer à un modèle de crédits unifié si on offre un jour Cloud BYOC | L (~2 sem) — pas urgent tant qu'on est appliance |
| **Marketplace store hybrid search** | `backend/api/features/store/hybrid_search.py` + `embeddings.py` | Aujourd'hui les marketplaces BoxIA sont statiques (catalogues JSON) → ajouter recherche full-text + vectorielle sur titre/desc des templates Dify/n8n/MCP/agents-fr | M (3-5j) |
| **Block schema → JSON Schema → UI form auto** | `BlockSchema.jsonschema()` + `frontend/src/app/(platform)/build/` | Notre `WorkflowsManager.tsx` et `AgentsManager.tsx` utilisent des forms hardcodés ; on pourrait générer les écrans depuis les schémas Dify/n8n | L (refacto frontend) |
| **AutoMod modération inputs** | `backend/executor/automod/manager.py` | Notre PII scrub n'est qu'output ; ajouter un check avant push à Dify pour bloquer les requêtes contenant des termes interdits (tier free) | S-M (1-3j) |

## A surveiller

- **Graph DAG xyflow builder** (`autogpt_platform/frontend/src/app/(platform)/build/`) — si on veut un jour exposer aux power-users TPE un builder visuel concurrent à n8n, c'est la bonne UI de ref. Mais probablement overkill pour notre cible "réceptionniste/comptable".
- **Subscription tiers avec rate-limit multipliers** (`backend/copilot/rate_limit.py`) — modèle simple et robuste si on monte un cloud BoxIA un jour.
- **External API publique avec OAuth applications** (`backend/api/external/`) — on en aura besoin quand des partenaires intégrateurs voudront brancher leurs SaaS sur BoxIA.
- **CLAUDE.md dans des sous-dossiers techniques** (`backend/copilot/graphiti/CLAUDE.md`, `backend/copilot/AGENTS.md`) — pratique pour scoper les instructions Claude par module.
- **Polyform Shield licence** — interdit de revendre AutoGPT comme service concurrent ; à étudier si on copie une grosse partie de l'architecture (block model peut s'inspirer sans copier).

## Pieges identifies

- **Stack lourde pour self-host** : Supabase + Kong + Auth + DB + Studio + Redis cluster 3 nœuds + RabbitMQ + FalkorDB + ClamAV + 5 services Python = ~20 conteneurs minimum, RAM 8GB minimum. Pour notre serveur appliance déjà à 33 conteneurs c'est un avertissement : éviter d'empiler RabbitMQ et FalkorDB en plus.
- **Polyform Shield** : `autogpt_platform/` interdit la concurrence cloud sur le code source. Code lecture-only pour notre projet ; tout ce qu'on copie doit être ré-implémenté indépendamment depuis l'idée, pas le code.
- **CLA exigée** pour contribuer ; pas un piège pour nous mais signale une stratégie de relicensing future.
- **Couplage Supabase fort** (`prisma.schema` qui mappe `User.id` au Supabase user ID, Kong devant) — leur archi auth ne se reswap pas facilement vers Authentik.
- **Block IDs UUID hardcodés** dans le code Python — chaque block a un UUID fixe persisté en DB, conflits de migration en cas de fork.
- **Subscription tiers DB-only** (`User.subscriptionTier` enum Prisma) — pas de mapping clean vers Stripe webhooks dans le code que j'ai lu, risque de drift si le webhook fail. À regarder de près si on copie le système crédits.
- **DEFAULT_TIER=PRO en bêta** : commentaire explicite que c'est volontaire, mais flippant pour qui ferait un fork-and-deploy sans lire (tout le monde se retrouve avec rate-limit 5x).
- **`copilot/baseline/` et `copilot/sdk/` divergent volontairement** au niveau modèles → 2 paths de prod à maintenir, double la surface de bugs.

## Top-3 preconisations BoxIA

### 1. **Sandbox d'exécution pour le Concierge (priorité haute, ROI x10)**
**Action** : ajouter un service `aibox-sandbox` (bubblewrap ou un e2b self-host) que le Concierge peut appeler via un nouveau tool `bash_exec` (mais protégé par approval-gate puisque marqué `is_sensitive_action`). Permet aux agents BoxIA de :
- Générer un PDF/xlsx/docx côté serveur depuis un prompt
- Manipuler un FEC, un export comptable, lancer un script Python ad-hoc
- Faire un appel API "exotique" qui n'a pas de connecteur dédié
**Coût** : 1-2 semaines (dev + tests sécurité). 
**Bénéfice** : débloque la moitié des "tâches IT" qu'un dirigeant TPE ne sait pas exprimer en workflow n8n. Transforme le Concierge de "wizard d'installation" en "opérateur générique".
**Source** : `backend/copilot/tools/bash_exec.py` + `backend/copilot/tools/e2b_sandbox.py` + protection HITL via `is_sensitive_action`.

### 2. **HITL générique + flag `is_sensitive_action` sur tous les tools mutatifs (priorité haute, ROI x5)**
**Action** : 
- Créer une table `PendingHumanReview` dans Postgres
- Étendre `lib/approval-gate.ts` (qui ne sert qu'au Concierge) à TOUS les tools mutatifs : `send_email`, `delete_document`, `oauth_revoke`, `n8n_run_workflow`, etc.
- Ajouter un attribut `is_sensitive_action: true` dans les routes `agents-tools/*/route.ts`
- UI : reuser `ConciergeApprovalBanner.tsx` mais générique
- Auto-approve key `(graph_exec_id, tool_id)` pour ne pas redemander à chaque exec
**Coût** : 3-5 jours.
**Bénéfice** : conformité RGPD/CNIL (le user valide chaque action mutative), confiance client TPE qui hésite à laisser un agent envoyer des mails. C'est le **différenciateur souveraineté** que les boîtes US ne mettent pas en avant.
**Source** : `backend/data/human_review.py` + `backend/blocks/_base.py:676-740` (méthode `is_block_exec_need_review`) + `backend/blocks/human_in_the_loop.py`.

### 3. **ProviderBuilder fluent + lifecycle hooks pour scaler le catalogue connecteurs FR (priorité moyenne, ROI x3 sur la roadmap)**
**Action** : refondre `lib/connectors.ts` + `lib/oauth-providers.ts` en un builder TypeScript : 
```ts
defineProvider("cegid")
  .withOAuth(CegidOAuthHandler, { scopes: [...] })
  .withApiKey()
  .withWebhook(CegidWebhookManager)
  .withBaseCosts({ type: "tokens", amount: 1 })
  .build();
```
Permet d'ajouter Cegid, Sage, EBP, Quadratus, MyUnisoft en 1 fichier de 30 lignes au lieu de toucher 6 endroits du code.
**Coût** : 3-5 jours de refacto + 1j par nouveau connecteur (vs 3-4j actuellement).
**Bénéfice** : scaler le marketplace FR à 15-20 connecteurs en 1 mois. Les blocs `webhooks/graph_lifecycle_hooks.py` permettent en plus de provisionner/désprovisionner les webhooks externes auto à activation/désactivation d'un workflow → critique pour Pennylane et Cegid qui pushent des events.
**Source** : `backend/sdk/builder.py:27` + `backend/sdk/provider.py:33` + `backend/integrations/webhooks/graph_lifecycle_hooks.py`.
