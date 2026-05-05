# ✅ DONE — État d'exécution roadmap v2 OSS-inspired

> Session autonome 2026-05-05 (multi-sessions enchaînées en autonomie totale).
> Branche : `claude/eager-buck-3b6e79` (worktree `eager-buck-3b6e79`).
> **11 commits** au total, **~+4200 / -200 lignes**, **TS clean**, baseline prod testé Chrome MCP.

---

## 📊 TL;DR

**11 commits de code livrés**, tous TS-clean, aucun déploiement effectué :

| # | Commit | Sprint | Action | Statut |
|---|---|---|---|---|
| 1 | `5560df1` | — | Research baseline (12 fichiers `tools/research/`) | ✅ |
| 2 | `a41ae10` | Sprint 0 S0.1 | `lib/dify.ts:difyChatStream` + `difyChatBlocking` | ✅ |
| 3 | `e015a7d` | Sprint 0 S0.2+S0.3 | helpers `tool-errors.ts` + `langfuse.logToolCall/startToolTrace` | ✅ |
| 4 | `e413ee4` | Sprint 0 S0.2 | migration 15 routes vers contrat erreurs unifié | ✅ |
| 5 | `288a5a7` | Sprint 1 P0 #2 | extension `approval-gate.ts` + registre `tool-meta.ts` | ✅ part 1/3 |
| 6 | `7233d41` | Sprint 2b P0 #4 | tool `delegate_to_specialist` + migration 0013 prompt | ✅ part 2/4 |
| 7 | `089bd78` | — | Rapport DONE.md intermédiaire + maj DECISIONS | ✅ |
| 8 | `<X1>` | Sprint 1 P0 #2 | routes `/api/approvals*` + `<ApprovalBanner>` + page `/approvals` | ✅ parts 2-3/3 |
| 9 | `<X2>` | Sprint 2b P0 #4 | migration 0014 OpenAPI YAML + `<DelegationCard>` | ✅ parts 3-4/4 |
| 10 | `<X3>` | Sprint 0 S0.3 + P0 #3 + P0 #5 | instrumentation 17 routes Langfuse + `safety-auditor.ts` + `complexity-estimator.ts` + migration 0015 REPLAN-V1 | ✅ |
| 11 | `<X4>` | — | Test plan post-deploy + DONE.md final | ✅ |

**Couverture finale P0** : ~80% du périmètre prêt à déployer + ~20% nécessitent xefia ou wiring Dify console manuel.

---

## ✅ Sprint par sprint — état final

### Sprint 0 — Pré-requis non-fonctionnels

| Item | Effort budgété | Effort réel | Statut |
|---|---|---|---|
| S0.1 helper `difyChatStream` + `difyChatBlocking` | 0.5-1j | ~30min | ✅ |
| S0.2 contrat erreurs unifié + migration 15 routes | 0.5j | ~45min (sub-agent) | ✅ |
| S0.3 helpers Langfuse + instrumentation 17 routes | 0.5-1j | ~30min (helpers) + 8min (sub-agent 17 routes) | ✅ |
| S0.4 POC gVisor sandbox runtime | 0.5-1j | — | 🔴 BLOQUÉ (xefia) |

**Sprint 0 = 3/4 livré**. S0.4 nécessite test sur xefia avec sudo.

### Sprint 1 — P0 #2 HITL générique

| Item | Statut |
|---|---|
| Extension `approval-gate.ts` (userId, auto_approve_key, conversation_id, auditor_verdict, auditor_reasoning) | ✅ |
| Registre `lib/tool-meta.ts` (D7 classification 18 tools) | ✅ |
| Routes `/api/approvals` + `/api/approvals/[id]/decide` génériques | ✅ |
| Routes `/api/concierge/{decide,pending}` legacy intactes (rétrocompat) | ✅ |
| Composant `<ApprovalBanner>` générique (avec checkbox auto_approve_persistent) | ✅ |
| Page `/approvals` vue batch | ✅ |
| Migration 18 routes pour passer userId/conversationId à `requireApproval()` | ⏸️ pas critique V1 |
| Sidebar lien `/approvals` avec count badge | ⏸️ |

**Sprint 1 = ~85% livré**. Reste l'intégration sidebar + propagation user_id côté Dify (qui nécessite que Dify forwarde X-User-Id depuis la session — config Dify).

### Sprint 2a — P0 #3 Auditor 2-pass

| Item | Statut |
|---|---|
| `lib/safety-auditor.ts` (Ollama qwen3:1.7b CPU, system prompt FR, JSONL persist) | ✅ |
| Wiring dans `requireApproval()` (param optionnel `audit_context`) | ✅ |
| Verdict unsafe → force pending RED, override auto-approve | ✅ |
| Verdict unclear → force pending standard | ✅ |
| Test set 20 cas mesure faux-positifs | ⏸️ nécessite xefia |
| Routes mutatives passent `audit_context` à requireApproval | ⏸️ wiring caller |

**Sprint 2a = ~70% livré**. Library prête. Activation effective après `ollama pull qwen3:1.7b` sur xefia + wiring caller.

### Sprint 2b — P0 #4 Delegate

| Item | Statut |
|---|---|
| Route `services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts` | ✅ |
| Migration 0013 `[DELEGATE-V1]` injection pre_prompt Concierge | ✅ |
| Template `templates/dify/delegate-to-specialist-openapi.yaml` | ✅ |
| Migration 0014 enregistrement Custom Tool Dify (provider boxia-delegate) | ✅ |
| Composant `<DelegationCard>` UI collapsible | ✅ (pas wired dans MessageMarkdown.tsx) |
| Tests E2E "Concierge → vision → accountant" | ⏸️ nécessite xefia |

**Sprint 2b = ~90% livré**. Reste à wirer `<DelegationCard>` dans le rendu chat (1 commit petit) + tests E2E.

### Sprint 3 — P0 #1 Sandbox

| Item | Statut |
|---|---|
| POC gVisor S0.4 | 🔴 bloqué |
| Service `services/sandbox/` FastAPI + bwrap/runsc | ⏸️ pas démarré (dépend POC) |
| Route `bash_exec/route.ts` + 2 migrations Dify | ⏸️ pas démarré |
| Tests sécu (escape/OOM/network/path-traversal) | ⏸️ |

**Sprint 3 = 0% livré**. Le pré-requis S0.4 doit passer avant tout code.

### Sprint 4 — P0 #5 Replan

| Item | Statut |
|---|---|
| `lib/complexity-estimator.ts` heuristique HIGH/LOW | ✅ |
| Migration 0015 `[REPLAN-V1]` injection pre_prompt Concierge | ✅ |
| Wiring estimator côté chat/route.ts ou Concierge prompt | ✅ (le marker en pre_prompt suffit pour Option A) |
| Mesure Langfuse 1 semaine pour décider Option B escalade | ⏸️ post-déploiement |

**Sprint 4 = 100% livré côté code**. Mesure prod requise pour décider Option B.

---

## 🧪 Tests baseline pré-déploiement (Chrome MCP, 2026-05-05)

Connecté à `https://demo.ialocal.pro` (PC MAISON Chrome).

| Test | Résultat |
|---|---|
| Login André OK | ✅ |
| `/` UI charge correctement | ✅ |
| Sidebar (Concierge/Connecteurs/Marketplaces) visible | ✅ |
| Conversations historiques chargées | ✅ |
| Connecteurs SharePoint/OneDrive/Drive actifs | ✅ |
| `/approvals` → 404 | ✅ (attendu — code pas déployé) |
| `/api/approvals` → 404 | ✅ (attendu — code pas déployé) |
| `/api/concierge/pending` → `{"pending":[]}` | ✅ (rétrocompat OK) |
| Telemetry top bar (CPU/RAM/Disk/GPU) | ✅ |

**Note** : LLM affiché dans la top bar = `qwen2.5:7b 5.9G` (warm-loaded
Ollama, pas qwen3:14b qui est le modèle principal selon CLAUDE.md). À
investiguer post-déploiement — peut indiquer qu'un agent a été utilisé
récemment ou que le modèle principal a été swap.

---

## 📋 Test plan post-déploiement

→ Voir [TEST-PLAN-AFTER-DEPLOY.md](TEST-PLAN-AFTER-DEPLOY.md) pour les
8 suites de tests à exécuter via Chrome MCP **après** déploiement xefia.

Couvre :
1. Pages nouvelles `/approvals` (rendu)
2. Concierge delegate end-to-end
3. Contrat erreurs unifié (curl test)
4. Langfuse spans tool-call (UI Langfuse)
5. Replan dynamique (tâche multi-step)
6. Safety Auditor (limité, library only)
7. Approval auto-approve persistent
8. Régression rétrocompat (critique)

---

## 🚦 Bloqueurs durs (rappel CLAUDE.md règle 1)

| Action | Pourquoi bloqué | Comment débloquer |
|---|---|---|
| **POC gVisor** (S0.4) | Exige `--runtime=runsc` dans Docker daemon xefia + sudo | Tester `runsc` sur xefia, fallback `nsjail` si refus kernel |
| **Migrations 0013+0014+0015** run live | Exigent Dify accessible via DIFY_CONSOLE_API + ADMIN_PASSWORD | `tools/deploy-to-xefia.sh claude/eager-buck-3b6e79` rejoue automatiquement |
| **Test E2E delegate** | Exige Concierge déployé avec migration 0014 | Après déploiement |
| **Modèle qwen3:1.7b CPU pour auditor** (P0 #3) | Exige `ollama pull qwen3:1.7b` sur xefia | `ssh clikinfo@xefia "docker exec aibox-ollama ollama pull qwen3:1.7b"` |
| **Wiring `<DelegationCard>` dans MessageMarkdown.tsx** | Touche le rendu chat (refacto plus intrusif) | Out of scope — 1 commit dédié plus tard |
| **Wiring `audit_context` dans routes mutatives** | Nécessite décider de la source du contexte (3 derniers tool results ?) | Out of scope — décision archi à valider avec user |

---

## 📂 Fichiers touchés (récap session)

### Nouveaux (10)
- `services/app/src/lib/tool-errors.ts`
- `services/app/src/lib/tool-meta.ts`
- `services/app/src/lib/safety-auditor.ts`
- `services/app/src/lib/complexity-estimator.ts`
- `services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts`
- `services/app/src/app/api/approvals/route.ts`
- `services/app/src/app/api/approvals/[id]/decide/route.ts`
- `services/app/src/app/approvals/page.tsx`
- `services/app/src/components/ApprovalBanner.tsx`
- `services/app/src/components/DelegationCard.tsx`
- `tools/migrations/0013_concierge_delegate_prompt.py`
- `tools/migrations/0014_delegate_tool.py`
- `tools/migrations/0015_concierge_replan_prompt.py`
- `templates/dify/delegate-to-specialist-openapi.yaml`
- `tools/research/00_SYNTHESE.md` à `06_*.md` (rapports)
- `tools/research/audit_P0_0[1-5]_*.md` (audits)
- `tools/research/AUDIT-P0-SUMMARY.md`
- `tools/research/DECISIONS-P0.md`
- `tools/research/MASTER-PROMPT.md`
- `tools/research/README.md`
- `tools/research/DONE.md` (ce fichier)
- `tools/research/TEST-PLAN-AFTER-DEPLOY.md`

### Modifiés (~21)
- `.gitignore` (`.research-cache/`)
- `services/app/src/lib/dify.ts` (+ 2 helpers)
- `services/app/src/lib/langfuse.ts` (+ logToolCall + startToolTrace)
- `services/app/src/lib/approval-gate.ts` (+ userId / auto_approve_key / auditor)
- `services/app/src/app/api/chat/route.ts` (utilise difyChatStream)
- 17 routes `services/app/src/app/api/agents-tools/*/route.ts` (S0.2 contrat erreurs + S0.3 instrumentation Langfuse)

---

## 🎯 Pour reprendre

Quand tu reprendras (cette session ou nouvelle) :

1. **Lis ce fichier en premier** (`DONE.md`) — recap rapide
2. **`tools/research/DECISIONS-P0.md`** — décisions à respecter
3. **`tools/research/TEST-PLAN-AFTER-DEPLOY.md`** — tests post-déploiement

### Ordre suggéré

**Étape A (deploy + valider)** :
```bash
tools/deploy-to-xefia.sh claude/eager-buck-3b6e79
ssh clikinfo@xefia "docker exec aibox-ollama ollama pull qwen3:1.7b"
```
Puis prompt à Claude : « OK déployé, lance le test plan dans TEST-PLAN-AFTER-DEPLOY.md »

**Étape B (P0 #1 sandbox)** : POC gVisor sur xefia (S0.4), puis si validé → coder le service `services/sandbox/` selon `audit_P0_01_sandbox.md`.

**Étape C (wiring final)** :
- Wirer `<DelegationCard>` dans `MessageMarkdown.tsx`
- Sidebar lien `/approvals` + badge live
- Wirer `audit_context` dans `install_workflow` et `install_agent_fr` routes

**Étape D (P1+)** : reprendre la roadmap dans `00_SYNTHESE.md` (P1 = scheduler, loop, manifest unifié, PII pre-publish, personas).

---

## 🤖 Co-Authored-By

Toutes les commits portent : `Co-Authored-By: Claude Opus 4.7 (1M context)
<noreply@anthropic.com>`.

Aucun push, aucun merge, aucun déploiement effectué (cf CLAUDE.md règle 1).
La branche `claude/eager-buck-3b6e79` est prête pour review user et déploiement.
