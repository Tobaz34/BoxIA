# Audit P0 #4 — delegate_to_specialist

## Existant BoxIA

### 1. Inventaire des agents Dify
6 agents statiques dans [services/app/src/lib/agents.ts](../../services/app/src/lib/agents.ts) (registre `AGENTS`, L49-167) :

| slug | name | rôles | vision | env clé |
|---|---|---|---|---|
| `general` | Assistant général | tous | non (qwen3:14b) | `DIFY_DEFAULT_APP_API_KEY` |
| `vision` | Assistant vision | tous | oui (qwen2.5vl:7b) | `DIFY_AGENT_VISION_API_KEY` |
| `accountant` | Assistant comptable | admin/manager | non | `DIFY_AGENT_ACCOUNTANT_API_KEY` |
| `hr` | Assistant RH | admin/manager | non | `DIFY_AGENT_HR_API_KEY` |
| `support` | Support clients | tous | non | `DIFY_AGENT_SUPPORT_API_KEY` |
| `concierge` | Concierge AI Box | admin only | non | `DIFY_AGENT_CONCIERGE_API_KEY` |

> **Note** : pas de `juridique` ni `marketing` codés en dur (le brief mentionne 4 spécialisés mais le repo a {accountant, hr, support, concierge}). `juridique`/`marketing` peuvent exister dynamiquement comme custom-agents via [services/app/src/lib/custom-agents.ts](../../services/app/src/lib/custom-agents.ts) (state `/data/custom-agents.json`) ou installed-agents marketplace ([services/app/src/lib/installed-agents.ts](../../services/app/src/lib/installed-agents.ts)). Le tool delegate doit donc résoudre le slug via la même logique que `requireDifyContext` (statique → installed → custom) plutôt qu'un whitelist hardcodé.

### 2. API Dify completion
[services/app/src/lib/dify.ts](../../services/app/src/lib/dify.ts) expose :
- `requireDifyContext(agentSlug)` (L25-100) → résout `{user, key, agent}` avec check rôle + statique/installed
- `difyFetch(path, {key, ...init})` wrapper Bearer
- `DIFY_BASE_URL` (default `http://localhost:8081`)

**Pas de helper `chat()` existant.** Le seul appel SSE complet est inliné dans [services/app/src/app/api/chat/route.ts](../../services/app/src/app/api/chat/route.ts) L92-108 :
```
POST `${DIFY_BASE_URL}/v1/chat-messages`
body: { inputs:{}, query, response_mode:"streaming", conversation_id, user, files }
Authorization: Bearer ${ctx.key}
```
Streaming SSE Dify avec events `message` + `agent_message` (cf L211-216 capture). Le pattern à factoriser pour delegate.

### 3. Concierge tools existants (17 routes sous `/api/agents-tools/`)
- `calendar_find_free_slot`, `calendar_today` — agenda Outlook/Google
- `deep_link` — résout URL deep link app
- `gmail_get_thread`, `gmail_read_inbox`, `gmail_search` — Gmail RAG
- `outlook_get_message`, `outlook_read_inbox`, `outlook_search` — Outlook RAG
- `install_workflow` — installe workflow n8n marketplace (avec approval gate)
- `install_agent_fr` — installe agent marketplace (approval gate)
- `list_connectors`, `list_marketplace_agents_fr`, `list_marketplace_workflows`
- `rag_search` — Qdrant gdrive+msgraph (cf migration 0010+0011)
- `system_health`, `web_search`
- `route.ts` racine — list générale

**Conventions** : auth `checkAgentsToolsAuth` Bearer `AGENTS_API_KEY` ([lib/agents-tools-auth.ts](../../services/app/src/lib/agents-tools-auth.ts)) ; `dynamic = "force-dynamic"` ; `audit-helper.logAction()` ; `requireApproval()` pour mutatifs ([lib/approval-gate.ts](../../services/app/src/lib/approval-gate.ts) déjà utilisé par `install_workflow` L52-59).

### 4. Conversation context / threading
Dify gère 1 conversation = 1 app + 1 user. **Pas de partage de conversation cross-app**. Donc déléguer = créer une **nouvelle conversation Dify isolée** côté agent specialist (ne pas passer `conversation_id` du parent → Dify ouvrira une nouvelle thread). Le specialist répond stateless du point de vue parent. Le Concierge reçoit le résultat comme tool message et l'inclut dans SA conversation.

### 5. Streaming SSE
Possible techniquement (le specialist répond aussi en SSE Dify), mais **complexe à relayer dans la conversation parent** : le Concierge mode `agent-chat` (function_call strategy depuis migration 0012) reçoit le tool result en string, pas en stream. **Recommandation V1 : agréger le stream specialist en string finale et la retourner**. Streaming "live du sub-agent" = V1.5 via SSE forwarding custom (hors scope P0).

## Composants à créer

1. Helper `lib/dify.ts:chatBlocking(slug, prompt, user, opts)` qui wrap fetch SSE + agrège `answer`. Réutilisable.
2. Route `api/agents-tools/delegate_to_specialist/route.ts` (POST).
3. Pre-prompt update Concierge (migration `0013_concierge_delegate_prompt.py`).
4. Custom Tool OpenAPI Dify (migration `0014_delegate_tool_dify.py` ou append à 0013).
5. UI : composant `DelegationCard` (collapsible) dans `services/app/src/components/Chat/`.

## Plan d'attaque détaillé

### Étape 1 — Tool route
- **Fichier** : `services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts`
- **Body** : `{slug: string, prompt: string}` (pas de `conversation_id` — le specialist est stateless V1)
- **Auth** : `checkAgentsToolsAuth(req)` Bearer `AGENTS_API_KEY` (cohérent avec les 17 autres tools)
- **Validation slug** : utiliser `listAllAvailableAgents()` (lib/agents.ts L196) pour résoudre **dynamiquement** (statique + installed + custom). Refuser `concierge` (self-delegation) et `slug` du caller (extrait du header `X-Caller-Agent`). Pas de whitelist hardcodé : si admin installe un agent juridique, il doit être délégable sans patcher le code.
- **Garde-fou récursion** : header `X-Delegation-Depth` (int, default 0). Le concierge passe 1, le specialist passerait 2 si lui-même délégait. **MAX_DEPTH = 2** dur en const. Refus 429 `delegation_depth_exceeded` si dépassé.
- **Garde-fou budget** : compter tokens estimés via Langfuse traceId injecté en metadata (cf chat/route.ts L78-90). Plus simple V1 : timeout 60s + max 3 délégations / conversation parent (tracker en mémoire process keyed par `conversation_id` parent passé en metadata, TTL 10min). Si dépassé → 429.
- **Implémentation** : appel `requireDifyContext(slug)` pour récupérer la clé du specialist + check rôle. Puis fetch SSE `/v1/chat-messages` avec `response_mode:"blocking"` (mode bloquant Dify natif) ou `"streaming"` agrégé. Préférer `blocking` V1 → 1 ligne JSON, plus simple. Risque : timeout côté Dify si specialist lent (>60s). À mitiger avec `AbortSignal.timeout(60_000)`.
- **Réponse** : `{slug, answer, latency_ms, tokens_used?}` plus `audit_log` via `logAction({actor: "concierge-agent", action: "delegate", target: slug, ...})`.
- **PAS d'approval gate** : la délégation n'est pas mutative (lecture/réflexion seulement). Si le specialist appelle un tool mutatif, c'est SON approval gate qui se déclenche (déjà géré).

### Étape 2 — Pre-prompt Concierge
- Migration `tools/migrations/0013_concierge_delegate_prompt.py` (pattern identique à 0011/0010).
- Append au pre_prompt Concierge un bloc `[DELEGATE-V1]` documentant le tool + 4-5 cas d'usage typiques :
  - "Question vision / image / OCR → delegate(`vision`, prompt)"
  - "Question comptable / TVA / facture → delegate(`accountant`, prompt)"
  - "Question RH / congés / contrat → delegate(`hr`, prompt)"
  - "Réponse client à rédiger → delegate(`support`, prompt)"
  - "Si custom agents installés (ex: `juridique-mc`), les énumérer dynamiquement via `list_marketplace_agents_fr`"
- Idempotent via marker `[DELEGATE-V1]` (cf pattern migration 0011 `[RAG-SEARCH-V1]`).

### Étape 3 — Custom Tool OpenAPI Dify
- Migration `0014_delegate_tool_dify.py` qui crée un Custom Tool `boxia-delegate` côté Dify et l'attache UNIQUEMENT à l'agent Concierge (pas aux specialists, pour éviter délégation transitive non auditée).
- OpenAPI spec : 1 endpoint POST avec params `slug` (string, enum dynamique injecté à la migration), `prompt` (string).
- Auth Custom Tool = même `AGENTS_API_KEY` que les autres (config Dify console api_key auth_type).
- Header `X-Caller-Agent: concierge` injecté en static header du Custom Tool (Dify le permet).

### Étape 4 — UI
- Composant `DelegationCard.tsx` collapsible dans `services/app/src/components/Chat/` :
  - Header : "🤝 Demande à `<specialist name>` (icône)…"
  - Body collapsible : prompt envoyé + réponse du specialist (markdown)
  - État : pending (spinner) / done (chevron) / error
- Détection : Concierge function_call émet event SSE `message_end` avec `metadata.tool_calls[].tool_name == "delegate_to_specialist"`. L'UI Chat.tsx (déjà handler agent_message + tool calls) intercepte et render `<DelegationCard>` au lieu d'un tool-call card générique.
- Pattern visuel proche d'un tool-call card existant (à reprendre depuis `MessageMarkdown.tsx` ou équivalent).

### Étape 5 — Tests
- **Unit** : route avec mock fetch Dify, asserts (1) refus si slug == caller, (2) refus si depth>2, (3) refus si AGENTS_API_KEY absent, (4) audit log écrit, (5) timeout 60s respecté.
- **E2E** : "donne-moi le statut TVA du dernier trimestre (compta) et reformule-le en mail formel pour mes clients (support)" → trace Langfuse doit montrer 2 spans children sous le span concierge.
- **Smoke live xefia** post-déploiement : test prompt unique vérifiant 1 délégation `general → accountant`.

## Risques
- **Récursion infinie** si specialist délègue back → MAX_DEPTH=2 dur + refus self-delegation.
- **Latence cumulée** : qwen3:14b ~3-8s/réponse local, 2 délégations chaînées = +10-20s. UX : afficher la card delegating dès le tool_call detected pour ne pas laisser l'utilisateur croire que ça freeze.
- **Pollution conversation** : si on stream tout dans la convo parent, le user voit du bruit. → V1 : un seul card collapsible, fermé par défaut, qui montre juste le résumé final.
- **Hallucination contexte** : le specialist ne voit PAS la conversation parent. Le Concierge doit packager un prompt auto-suffisant. Le pre_prompt doit le rappeler ("le specialist n'a aucun contexte préalable, sois explicite").
- **Coût tokens** : multipliés par N délégations → tracking Langfuse essentiel pour facturation BYOK.
- **Function calling Qwen3 lent** (cf MEMORY sprint_2026-05-01_full_recap.md) → le concierge mettait déjà du temps à invoquer ses tools. Délégation = +1 round-trip LLM. Acceptable mais à mesurer.

## Estimation
- Étape 1 (route) : 4-6h (avec tests unit)
- Étape 2 (pre-prompt migration) : 1h (pattern connu, copy 0011)
- Étape 3 (Custom Tool Dify migration) : 3-4h (auth Dify console déjà gérée par 0012, mais OpenAPI spec à designer)
- Étape 4 (UI) : 4-6h (réutilise pattern tool-call existant)
- Étape 5 (tests + smoke) : 2-3h
- **Total : ~2 jours dev** (cohérent avec l'estim de `06_local_operator.md` L214).
- **Complexité** : moyenne. Pas de nouveau pattern infra, juste compose des briques existantes (requireDifyContext + fetch SSE + approval-gate-like + migration runner + Custom Tool Dify déjà fait pour 17 tools).

## Ordre vs autres P0
**Indépendant** des P0 #1/#2/#3 (je suppose : RAG fix / file-marker / orchestration tools). Peut être développé en parallèle. **Dépendances** :
- Migration 0012 (function_call strategy) : ✅ déjà mergée — prérequis pour fiabiliser tool invocation.
- Pattern Custom Tool Dify : ✅ déjà rodé par migrations 0007 (gmail), 0009 (outlook), 0010 (rag_search).

**Risque de conflit** uniquement si un autre P0 modifie la résolution slug (`requireDifyContext`) ou ajoute un agent statique. À coordonner via lock `deploy-to-xefia.sh` au moment du déploiement uniquement.

**Recommandation** : faire après le fix `[FILE:...]` runtime (BUG-006) si ce dernier est encore non-stabilisé, sinon foncer.
