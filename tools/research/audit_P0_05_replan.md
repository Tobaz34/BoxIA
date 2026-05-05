# Audit P0 #5 — Replan dynamique + complexity routing

> Source d'inspiration : `D:\IA_TPE_PME_POWER\.research-cache\agentic-seek\sources\agents\planner_agent.py:184` (`update_plan`) et `sources\router.py:401` (`estimate_complexity`).
> ⚠️ AgenticSeek est **GPL-3.0** → réimplémenter, ne pas copier le code.

---

## 🔍 Existant BoxIA

### 1. Pre-prompt actuel du Concierge

Le pre-prompt est patché par 2 migrations récentes :

- **[`tools/migrations/0011_rag_search_pre_prompt.py:47-90`](../migrations/0011_rag_search_pre_prompt.py)** — injecte un bloc `[RAG-SEARCH-V1]` (~1 600 chars) qui décrit QUAND/COMMENT appeler `rag_search`, COMMENT exploiter les `hits`, et QUAND ne pas l'appeler. Ciblé sur 4 agents (Assistant général, Concierge BoxIA, Assistant tri emails, Assistant compta).
- **[`tools/migrations/0006_consolidate_pre_prompts.py:68-108`](../migrations/0006_consolidate_pre_prompts.py)** — ajoute un bloc `[AGENT-RULES-V2]` ou `[ACCOUNTANT-RULES-V2]` (générique : 4 règles d'usage sur données fournies / réponse courte / `[FILE:...]` / noms propres).

**Aucune mention de tool-chaining, plan JSON, ni résilience aux erreurs.** Le pre-prompt suppose un raisonnement one-shot : « appelle le bon tool, exploite le résultat, réponds ». Pas de notion de plan multi-step ni de récupération sur erreur.

### 2. Comportement actuel sur tool fail

Les 17 tools dans [`services/app/src/app/api/agents-tools/`](../../services/app/src/app/api/agents-tools/) renvoient sur erreur un **HTTP 4xx/5xx** avec `{ error: "code", hint: "..." }` (ex: [`rag_search/route.ts:46-51`](../../services/app/src/app/api/agents-tools/rag_search/route.ts) renvoie 400 `missing_query`, 502 `embed_failed`). Côté Dify (mode `function_call`, cf §3) :
- En cas d'erreur HTTP, Dify renvoie le body au LLM comme `tool_response` brut.
- Le LLM décide : retry (rare car pas instruit), abandon, ou hallucination.
- **Aucun mécanisme de replan formel** : le Concierge ne sait pas réécrire un plan multi-step à partir du step en échec.

### 3. Stratégie agent Dify

Migration **[`0012_agent_strategy_function_call.py`](../migrations/0012_agent_strategy_function_call.py)** a switché tous les agents avec tool BoxIA de `react` → `function_call` (qwen3:14b a un FC natif). Conséquences :
- ✅ Plus fiable que ReAct sur Qwen3.
- ❌ **Plus de "Thought" intermédiaire visible**. Le LLM appelle directement la fonction, Dify gère le serialize/deserialize. La perte du raisonnement explicite rend plus difficile la détection « cette étape va échouer » côté LLM.
- ❌ Dify en mode `function_call` ne ré-invoque PAS automatiquement le LLM avec un prompt de récupération sur tool error — c'est l'agent qui décide via son contexte.

### 4. Lib orchestration côté Next.js

**Aucune** — pas de fichier `lib/concierge.ts` ou `lib/replan*`. Le seul endpoint orchestré est [`services/app/src/app/api/concierge/decide/route.ts`](../../services/app/src/app/api/concierge/decide/route.ts) qui gère uniquement l'**approval gate** (validation admin pour tools mutatifs) — pas de replan. Le chat passe par [`services/app/src/app/api/chat/route.ts`](../../services/app/src/app/api/chat/route.ts) qui est un proxy SSE pur vers Dify (filtre `<think>`, file marker, mémoire mem0). Aucune couche d'orchestration entre prompt user et Dify.

### 5. Langfuse traces existantes

[`services/app/src/lib/langfuse.ts`](../../services/app/src/lib/langfuse.ts) pose une trace racine par message (`startTrace`) + permet `logGeneration`/`updateTrace`. ✅ Tags supportés (`tags: string[]`). ❌ **Aucun span tool-call** logué pour l'instant (seul `chat:<agent>` au niveau trace). Visibilité actuelle sur les chains : Langfuse UI affiche input/output mais pas le détail step-by-step des tool-calls intermédiaires.

---

## 🧱 Composants à créer / modifier

| # | Composant | Type | Effort |
|---|-----------|------|--------|
| 1 | `tools/migrations/0013_concierge_replan_prompt.py` | Migration prompt (marker `[REPLAN-V1]`) | 0.5j |
| 2 | `services/app/src/lib/replan-helper.ts` | Wrapper orchestration côté Next.js | 1j |
| 3 | `services/app/src/lib/complexity-estimator.ts` | Pre-routing HIGH/LOW (LLM few-shot ou heuristique) | 0.5j |
| 4 | `services/app/src/app/api/agents-tools/estimate_complexity/route.ts` | Tool exposé optionnel | 0.5j |
| 5 | Étendre `lib/langfuse.ts` avec `logToolCall()` + spans `replan:N` | Observability | 0.5j |
| 6 | Tests E2E `tests/replan-*.test.ts` | QA | 0.5j |

---

## 🎯 Plan d'attaque détaillé

### Étape 1 — Pre-prompt enrichi

Créer **`tools/migrations/0013_concierge_replan_prompt.py`** sur le pattern de `0011` (auth Dify cookies+CSRF, marker idempotent, ciblé Concierge BoxIA + Assistant général). Bloc à injecter :

```
[REPLAN-V1]
TÂCHES MULTI-STEP — Plan + auto-correction

Si la demande user nécessite ≥2 tools chaînés (ex: "trouve facture X
dans Pennylane → télécharge PDF → envoie par mail"), AVANT d'agir :

1. EXPOSE ton plan en JSON dans un bloc ```json :
   { "steps": [
       {"id":1, "tool":"rag_search", "args":{...}, "depends_on":[]},
       {"id":2, "tool":"gmail_search", "args":{...}, "depends_on":[1]}
     ]}
2. Exécute step par step. Après chaque tool_response, vérifie :
   - Si le tool a renvoyé `error` ou un résultat vide inattendu :
     RÉÉCRIS le plan à partir du step en échec, en gardant les
     steps déjà réussis. Indique dans le nouveau plan pourquoi
     tu replanifies. Tente max 2 replans, puis abandonne
     proprement avec un message user.
   - Si le tool a réussi : passe au step suivant.
3. À la fin, résume les actions effectuées + résultats clés.

POUR LES DEMANDES SIMPLES (1 tool) : ignore ce protocole, appelle
directement le tool. Exemples LOW : "quelle heure ?", "envoie un
mail à X disant Y", "cherche le contrat ABELLO" → tool direct.

Few-shot HIGH : "récupère les 3 dernières factures Pennylane
impayées et envoie un récap à mon comptable" → plan 3 steps.
Few-shot LOW : "résume mon dernier mail de Pierre" → tool direct.
```

### Étape 2 — Wrapper `lib/replan-helper.ts` (recommandé)

Dify en mode `function_call` ne fait pas le replan natif (cf §3). Deux options :

- **Option A (light)** — Confier le replan au LLM via le prompt seul (étape 1). Marche si Qwen3:14b est suffisamment auto-correcteur. À tester en premier.
- **Option B (robust)** — Wrapper Next.js qui intercepte les tool-calls Dify, détecte erreur, ré-injecte un prompt « step X a échoué avec erreur Y, réécris ton plan ». Nécessite de bypasser le SSE Dify natif → refactor non-trivial du `/api/chat/route.ts`.

**Recommandation : commencer par Option A**, mesurer en prod avec Langfuse, escalader vers B si taux de fail > 30%.

### Étape 3 — Pre-routing complexity (HIGH/LOW)

`services/app/src/lib/complexity-estimator.ts` :

```ts
// Heuristique simple OU appel LLM léger (few-shot 5 exemples)
export async function estimateComplexity(prompt: string): Promise<"HIGH" | "LOW"> {
  // V1 : heuristique regex (≥2 verbes d'action chainés, "puis", "et envoie", "→")
  // V2 : appel à un endpoint Dify léger qwen3:14b avec few-shot HIGH/LOW
  // Fallback : "LOW"
}
```

Hook dans `/api/chat/route.ts` AVANT le proxy Dify : si `HIGH`, prepend au query un toggle `[FORCE_PLAN_MODE=true]` que le pre-prompt sait reconnaître pour activer le mode plan. Si `LOW`, passe direct (économie tokens).

### Étape 4 — Logging Langfuse

Étendre `lib/langfuse.ts` avec :

```ts
export function logToolCall(opts: {
  traceId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  replanDepth?: number;  // 0 = first attempt, 1 = after replan, etc.
});
```

Tags : `replan:0`, `replan:1`, `replan:2`, `complexity:HIGH`, `complexity:LOW`. Métriques calculables côté Langfuse UI : % succès direct, % succès après replan-1, % fail après MAX_REPLANS=2.

### Étape 5 — Tests

Cas critiques :
1. `rag_search` retourne 0 hits → l'agent doit replan (ex: chercher dans gmail à la place) sans crasher.
2. `gmail_search` 502 (Google down) → message user clean « impossible d'accéder à Gmail, veux-tu réessayer ? ».
3. Demande LOW (« quelle heure ? ») → pas de plan JSON, réponse directe en <2s.
4. Demande HIGH (3 tools chaînés) → plan exposé, exécution séquentielle, résumé final.

---

## ⚠️ Risques

- **Boucle infinie** : MAX_REPLANS=2 hard-codé dans le prompt + watchdog côté wrapper si Option B.
- **Coût tokens** : un plan + 1 replan = 3-5× les tokens. Acceptable pour HIGH (rare), à éviter pour LOW (pre-routing critique).
- **Qwen3:14b function_call + replan** : à tester. Le mode FC natif perd les "Thought" intermédiaires. Si le LLM ne sait pas exposer un plan JSON ET appeler des fonctions dans le même tour, fallback prompt : « expose ton plan en réponse texte AVANT le 1er function_call ».
- **Pollution UI streaming** : si on streame chaque iteration de replan, le user voit du JSON brut. Solution : intercepter côté `/api/chat/route.ts` les blocs ```json plan``` et les masquer (comme on fait pour `<think>` dans `lib/strip-think.ts`).
- **Conflit avec approval gate** : un step mutatif (ex: `install_workflow`) en plein milieu d'un plan déclenche le gate. Le replan doit savoir attendre la décision admin avant de continuer le step suivant.

---

## 📊 Estimation

**Effort total : 3–4 jours dev + 1 jour QA** (Option A). Option B ajoute +2j refactor SSE.
**Complexité : moyenne**. Pas de breaking change. Migrable côté prompt seul si Option A suffit.

---

## 🚦 Ordre vs autres P0

- **Après #4 (delegate)** : si #4 introduit un dispatch Concierge → agent spécialisé, le replan doit être conscient de cette délégation (un step peut être « délègue à l'Assistant compta »). Sinon refactor double.
- **Avant tout sprint browse/scrape** : le `web_navigate` futur (cf top-3 préco AgenticSeek §2) supposera un agent capable de chaîner `navigate → fill → click → extract` — replan obligatoire.
- **En parallèle de Langfuse spans** : le logging tool-call (étape 4) est utile indépendamment. Peut être fait en preview sans toucher au prompt.

**Recommandation : bloquer #5 sur la finalisation de #4, faire l'étape 4 (logging) en parallèle dès maintenant.**
