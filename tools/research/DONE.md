# ✅ DONE — État d'exécution roadmap v2 OSS-inspired

> Session autonome 2026-05-05.
> Branche : `claude/eager-buck-3b6e79` (worktree `eager-buck-3b6e79`).
> 6 commits, ~+1700 / -150 lignes de code, 1 commit doc + 5 commits feat/refactor.

---

## 📊 TL;DR

**5 commits de code livrés**, tous TS-clean, aucun déploiement effectué :

| Commit | Sprint | Action | Effort budgété | Statut |
|---|---|---|---|---|
| `5560df1` | — | Research baseline (12 fichiers `tools/research/`) | — | ✅ |
| `a41ae10` | Sprint 0 | S0.1 — `lib/dify.ts:difyChatStream` + `difyChatBlocking` | 0.5-1j | ✅ |
| `e015a7d` | Sprint 0 | S0.2+S0.3 — helpers `lib/tool-errors.ts` + `langfuse.logToolCall/startToolTrace` | 1j | ✅ helpers |
| `e413ee4` | Sprint 0 | S0.2 — migration 15 routes vers contrat erreurs unifié | 0.5j | ✅ |
| `288a5a7` | Sprint 1 | P0 #2 — extension `approval-gate.ts` + registre `lib/tool-meta.ts` | 3.5j budgété | ✅ partie 1/3 |
| `7233d41` | Sprint 2b | P0 #4 — tool `delegate_to_specialist` + migration 0013 pre_prompt | 2j budgété | ✅ partie 2/4 |

**Bloqueurs durs identifiés (impossibles seul) :**
- ❌ S0.4 POC sandbox runtime gVisor — exige runtime Docker xefia + sudo
- ❌ Déploiement xefia — interdit par CLAUDE.md règle 1
- ❌ Migrations Dify live — requièrent DB Dify accessible

**Reste à faire avant Sprint 1+2b complets** (~5-7 j-h) :
- Sprint 1 P0 #2 : routes génériques `/api/approvals*`, UI `<ApprovalBanner>` extracté + page `/approvals`, propagation header user/conversation, migration des 18 routes pour passer userId/conversationId à `requireApproval()`
- Sprint 2b P0 #4 : migration 0014 enregistrement Custom Tool Dify (OpenAPI YAML), composant UI `<DelegationCard>`
- Sprint 0 S0.3 : instrumenter les 18 routes avec `startToolTrace()` (mécanique, ~0.5j)

---

## 🏗️ Détail par commit

### 1. `5560df1` — docs(research) — research baseline

Stage de tous les livrables produits avant cette session de code :
- `00_SYNTHESE.md` (matrice patterns × 6 projets, 21 actions P0/P1/P2/P3)
- `01_autogpt.md` à `06_local_operator.md` (rapports détaillés par projet)
- `AUDIT-P0-SUMMARY.md` (5 audits + plan sprint par sprint)
- `audit_P0_0[1-5]_*.md` (audits détaillés par action P0)
- `DECISIONS-P0.md` (7 décisions architecturales validées)
- `MASTER-PROMPT.md` (prompt agent autonome)
- `README.md` (index)

`.research-cache/` ajouté au `.gitignore` (clones OSS hors repo).

### 2. `a41ae10` — refactor(S0.1) — factorise `lib/dify.ts`

**Pourquoi** : `/api/chat/route.ts:92-108` contenait un appel `fetch()` direct à `/v1/chat-messages` non réutilisable pour les futurs consommateurs (delegate, auditor).

**Quoi** :
- 2 helpers dans `lib/dify.ts` partageant l'interface `DifyChatOptions {user, key, query, conversationId?, files?, inputs?, signal?}` :
  - `difyChatStream(opts)` → `{ ok: true, response, body } | { ok: false, status, bodyPreview }` — mode streaming SSE, body explicitement non-nullable côté happy path
  - `difyChatBlocking(opts & { timeoutMs? })` → `{ ok, answer, conversationId, messageId }` — mode blocking JSON, timeout configurable (défaut 60s) via AbortController
- `/api/chat/route.ts` migré : 17 lignes inline → 8 lignes typées
- Type `DifyFile` exporté pour réutilisation externe

### 3. `e015a7d` — feat(S0.2+S0.3) — helpers contrat erreurs + Langfuse spans

**S0.2 — `lib/tool-errors.ts` (NEW)** :
Standardise la forme d'erreur des routes `/api/agents-tools/*` en
`{ ok: false, error, hint, retryable, retry_after_ms?, detail? }`.

3 helpers ergonomiques :
- `toolValidationError(error, hint)` → 400 retryable=false (input/zod)
- `toolConfigError(error, hint)` → 503 retryable=false (env manquante)
- `toolUpstreamError({error, hint, upstreamStatus?, retryAfterMs?})` → 502 retryable=true
- `toolError(opts)` — cas custom

**Pourquoi `retryable`** : le futur replan-helper P0 #5 doit distinguer
retryable (5xx/timeout/rate-limit) vs fatal (validation/auth/config) pour
éviter boucle infinie ou abandon prématuré.

**S0.3 — `lib/langfuse.ts` extension** :
- `logToolCall(opts)` — bas niveau, log direct un span ou trace standalone
  avec tags `tool:<name>`, `agent:<slug>`, `status:success/failure`,
  `error:<code>`, `retryable`. Metadata duration_ms/http_status/error_code.
- `startToolTrace({toolName, req, agentSlug?})` — wrapper ergonomique
  pour routes : retourne `{success(output), failure({errorCode,…})}`.
  Lit `X-Langfuse-Trace-Id` / `X-Conversation-Id` / `X-User-Id` headers
  (propagation future quand Dify les forwarde).

**Pourquoi** : avant, Langfuse loguait les traces racine `chat:<agent>`
mais aucun span pour les tool-calls → visibilité 0 sur les chains
"trouve facture → télécharge → envoie mail".

### 4. `e413ee4` — refactor(S0.2) — migration 15 routes vers contrat erreurs

Sub-agent dispatché en parallèle pendant les commits suivants. ~36
migrations sur 15 fichiers (3 routes sans erreurs métier non touchées :
`list_connectors`, `deep_link`, `route.ts` wrapper).

Migration faite via heuristique :
- 4xx (sauf 408/425/429) → retryable=false
- 408/425/429/5xx → retryable=true
- Validation input/zod → retryable=false
- Config absente → retryable=false

Routes migrées : `web_search`, `rag_search`, `system_health`,
`outlook_*` (3), `gmail_*` (3), `list_marketplace_*` (2),
`install_*` (2), `calendar_*` (2).

`tsc --noEmit` clean post-migration.

### 5. `288a5a7` — feat(P0 #2) — HITL générique partie 1/3

**`lib/tool-meta.ts` (NEW)** : registre source-de-vérité pour la
classification `is_sensitive_action` des 18+ tools. Pour chaque tool :
- `isSensitive` → pilote la HITL
- `outputReinjected` → vecteur potentiel d'injection (active SafetyAuditor P0 #3)
- `riskTier` (low/medium/high) → priorisation auditor + UI severity
- `description` FR
- `category` (search/email/calendar/documents/system/marketplace/delegate/exec/rag)

Inclut déjà toutes les classifications de la décision D7
(DECISIONS-P0.md), y compris **placeholders** pour P0 #1 (`bash_exec`,
`isSensitive: true`) et P0 #4 (`delegate_to_specialist`,
`isSensitive: false`).

**`lib/approval-gate.ts` extension rétrocompatible** :
- 3 nouveaux champs optionnels sur `PendingApproval` : `user_id`,
  `auto_approve_key`, `conversation_id`
- Nouvelle `findAutoApproved(action, key)` : cherche une approbation
  persistante encore active pour cette (action, key) → bypass silencieux
- `createPending` accepte les nouveaux champs (rétrocompat)
- `listActive(userId?)` filtre par userId si fourni (legacy sans
  user_id reste visible à tous = rétrocompat)
- `decide(id, decision, opts?)` accepte `auto_approve_persistent: bool`
- `requireApproval` étendu : 3 branches (token explicite → consume,
  auto-approval existante → bypass, sinon → crée pending)

**Pending pour P0 #2 complet** :
- Migration des 18 routes pour passer `userId`/`conversationId`
- Routes génériques `/api/approvals*` + alias rétrocompat
  `/api/concierge/{decide,pending}`
- Composant `<ApprovalBanner>` extracté de `ConciergeApprovalBanner.tsx`
- Page `/approvals` listing batch avec filter user
- Toggle UI "ne plus me redemander pour cette tâche"

### 6. `7233d41` — feat(P0 #4) — delegate_to_specialist + migration 0013

**`services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts` (NEW)** :
18ème tool route. Permet au Concierge de déléguer en blocking à
un specialist (general/vision/accountant/hr/support).

Garde-fous (D5) :
- `MAX_DEPTH=2` (env `AGENTS_DELEGATE_MAX_DEPTH`) via header
  `X-Delegation-Depth` ou body.depth
- Refus self-delegation (`slug === "concierge"` ou `slug === caller`)
- Slug doit exister dans `AGENTS` statiques OU `installed-agents` marketplace
- Timeout 60s (env `AGENTS_DELEGATE_TIMEOUT_MS`)
- RBAC light via `X-User-Groups` (best-effort si Dify forwarde)

Utilise `difyChatBlocking()` (helper S0.1). Conversation isolée per
D5 option A.

Audit log `agent.chat` + Langfuse `logToolCall` avec metadata
`target_slug` + `depth` + `answer_chars`.

Réponse succès : `{ ok: true, agent: {slug,name,icon}, answer,
conversation_id, depth, hint }` — le hint guide le LLM appelant à
synthétiser plutôt que copier-coller.

**`tools/migrations/0013_concierge_delegate_prompt.py` (NEW)** :
Injecte bloc `[DELEGATE-V1]` en tête du pre_prompt Concierge BoxIA.
Pattern hérité de 0011 (RAG-SEARCH-V1). Idempotente.

**Pending pour P0 #4 complet** :
- Migration 0014 enregistrement Custom Tool Dify avec OpenAPI YAML
- Composant UI `<DelegationCard>` collapsible "🤝 Demande à [agent]: ..."
- Tests E2E (délégations enchaînées, profondeur, refus self)

---

## 🚦 Bloqueurs durs (rappel CLAUDE.md règle 1)

Ces actions exigent xefia ou validation user explicite — je ne les
fais PAS en autonome :

| Action | Pourquoi bloqué | À faire par l'user |
|---|---|---|
| **POC gVisor** (S0.4) | Exige `--runtime=runsc` dans Docker daemon xefia + sudo | Tester `runsc` sur xefia, fallback `nsjail` si refus kernel |
| **Migration 0013 run live** | Exige Dify accessible via DIFY_CONSOLE_API + ADMIN_PASSWORD | `tools/deploy-to-xefia.sh <branche>` rejoue automatiquement |
| **Migration 0014 OpenAPI YAML** | À écrire en suivant pattern de 0007 ou 0010 | Out of scope cette session — refer audit_P0_04_delegate.md §Étape 3 |
| **Test E2E delegate** | Exige Concierge en prod sur xefia | Après déploiement |
| **Modèle qwen3:1.7b CPU pour auditor** (P0 #3) | Exige `ollama pull qwen3:1.7b` sur xefia | Pré-requis avant sprint 2a P0 #3 |

---

## 📂 Fichiers touchés (15)

**Nouveaux** (5) :
- `services/app/src/lib/tool-errors.ts`
- `services/app/src/lib/tool-meta.ts`
- `services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts`
- `tools/migrations/0013_concierge_delegate_prompt.py`
- `tools/research/DONE.md` (ce fichier)

**Modifiés** (10) :
- `.gitignore` (+`.research-cache/`)
- `services/app/src/lib/dify.ts` (+91 lignes : helpers chat)
- `services/app/src/lib/langfuse.ts` (+170 lignes : logToolCall + startToolTrace)
- `services/app/src/lib/approval-gate.ts` (+90 lignes : userId/auto_approve_key)
- `services/app/src/app/api/chat/route.ts` (-17 +8 : utilise difyChatStream)
- 15 routes `services/app/src/app/api/agents-tools/*/route.ts` (S0.2 contrat erreurs)

---

## 🎯 Prochaine session — recommandation

Quand tu reprendras :

1. **Lis ce fichier en premier** (`DONE.md`) — recap rapide
2. **`tools/research/DECISIONS-P0.md`** — décisions à respecter
3. **Stratégie suggérée** :
   - **Option A (mécanique)** : finis P0 #2 partie 2/3 (UI + routes génériques) puis 3/3 (migration 18 routes pour passer userId). ~3-4j seul.
   - **Option B (impactant business)** : POC gVisor (S0.4) + démarrer P0 #1 sandbox. Bloqué tant que tu n'as pas validé le runtime sur xefia.
   - **Option C (déploiement actuel)** : `tools/deploy-to-xefia.sh claude/eager-buck-3b6e79` pour tester sur prod ce qu'on a déjà (delegate tool + helpers).
4. Si tu testes le delegate tool en prod, **avant** :
   - Vérifier que le PR registration migration 0014 est faite OU
   - Enregistrer le Custom Tool dans Dify console manuellement (URL : POST `https://demo.ialocal.pro/api/agents-tools/delegate_to_specialist`, OpenAPI minimal à dériver de la signature route)

---

## 📊 Cumul effort réel vs budgété

| Sprint | Budgété (audit) | Effort réel session | % livré |
|---|---|---|---|
| Sprint 0 (S0.1+S0.2+S0.3) | 1.5-2j | ~0.5j | ✅ helpers + S0.1 + S0.2 routes ; S0.3 routes pending |
| Sprint 1 P0 #2 HITL | 3.5j | ~0.3j | ✅ partie 1/3 (extension lib + tool-meta) |
| Sprint 2b P0 #4 delegate | 2j | ~0.4j | ✅ partie 2/4 (route + migration 0013) |
| **Total** | **7-7.5j** | **~1.2j de code livré** | **~30% du périmètre P0** |

Reste ~5-6 j-h pour atteindre P0 fini (toujours hors P0 #1 sandbox + P0 #3
auditor + P0 #5 replan qui sont les sprints 3-4 dans l'ordre du plan).

---

## 🤖 Co-Authored-By

Toutes les commits portent : `Co-Authored-By: Claude Opus 4.7 (1M context)
<noreply@anthropic.com>`.

Aucun push, aucun merge, aucun déploiement effectué (cf CLAUDE.md règle 1).
La branche `claude/eager-buck-3b6e79` est prête pour review user.
