# 🧭 Synthèse — Audits des 5 actions P0

> Date : 2026-05-05.
> Sources : `audit_P0_01_sandbox.md`, `audit_P0_02_hitl.md`, `audit_P0_03_auditor.md`, `audit_P0_04_delegate.md`, `audit_P0_05_replan.md`.
> Synthèse à lire AVANT de lancer l'implémentation.

---

## 🎯 TL;DR

**Les 5 audits convergent sur 3 conclusions structurantes** :

1. **BoxIA est mieux préparé que prévu**. `requireApproval()` est déjà générique (params arbitraires + TTL token). 2 tools sur 18 sont déjà gatés. Le banner `ConciergeApprovalBanner.tsx` est trivialement réutilisable. Pattern de migrations Dify mature.
2. **Pas de Postgres dans BoxIA Next.js — tout en filesystem JSONL** (`/data/audit.jsonl`, `/data/concierge-approvals/<id>.json`). Décision forte : **rester filesystem en V1** (cohérence stack, 0 container ajouté). Postgres = sur-ingénierie pour le besoin actuel.
3. **L'ordre original P0 #1→#5 est faux**. Le vrai chemin critique est :  
   **Sprint 0 (pré-requis) → P0 #2 (HITL) → P0 #3 (auditor) + P0 #4 (delegate) parallèle → P0 #1 (sandbox) → P0 #5 (replan)**.

**Coût total cumulé** : ~16-17.5 jours-homme (P0 uniquement).
**Parallélisable** : P0 #4 (delegate) peut tourner en parallèle de P0 #2-3 → ~13-14 jours sur le chemin critique.

---

## 🔧 Corrections du brief synthèse `00_SYNTHESE.md`

| Point | Brief original | Réalité auditée |
|---|---|---|
| Nombre de tools agents-tools | "17 tools" | **18 tools** (j'avais raté `rag_search`) |
| 6 agents Dify | "1 général + 1 vision + 4 spécialisés (compta/juridique/RH/marketing)" | **`general/vision/accountant/hr/support/concierge`** (pas juridique ni marketing — ils peuvent exister comme custom-agents installés via marketplace) |
| Backend state | "table Postgres `pending_human_review`" | Filesystem JSONL recommandé. App Next.js BoxIA n'a aucune dépendance Postgres dans `package.json` |
| Audit log | "lib/audit.ts" | Le bon fichier est `lib/app-audit.ts`, type `AuditAction` à étendre `hitl.*` |
| approval-gate | "couvre uniquement le Concierge" | **Déjà générique côté params** (TTL token, params arbitraires). Limitations réelles : pas de `userId`, pas d'`auto_approve_key`, pas de classification `is_sensitive_action`. |
| `lib/secrets-redact.ts` | Implicitement présent | **N'existe pas**. Filtres existants (`strip-think`, `pii-scrub`) sont **outbound only** — aucune défense **inbound** contre injection. |

→ Je corrige aussi le `00_SYNTHESE.md` à la fin de cette session.

---

## 📊 Récap par action

| Action | Effort | Complexité | Verdict | Bloque | Bloqué par | Risque #1 |
|---|---|---|---|---|---|---|
| **P0 #1** sandbox | **5-6j** | M | 🟡 viable | — | P0 #2 | 🔴 `bwrap-in-Docker` exige `CAP_SYS_ADMIN` ou bubblewrap-suid → POC J1 obligatoire, alt gVisor |
| **P0 #2** HITL filesystem | **3.5j** | S/M | 🟢 simple | #1, #3 | rien | UI fatigue si trop de pending sans batch UI |
| **P0 #3** auditor 2-pass | **2.5j** | S | 🟢 simple | — | P0 #2 | Faux positifs Qwen3 14B → reco **qwen3:1.7b CPU** (200-800ms, libère GPU) |
| **P0 #4** delegate | **2j** | S | 🟢 simple | — | refacto `lib/dify.ts:chat()` léger | Récursion infinie → MAX_DEPTH=2 dur |
| **P0 #5** replan Option A | **3-4j** | M | 🟡 mesurer | — | P0 #4 + Langfuse spans | Boucle infinie → MAX_REPLANS=3 dur. Coût tokens x3-5. |

**Total chemin critique** : 1-2 (Sprint 0) + 3.5 (P0#2) + max(2.5+2 // 5-6) (P0#3+#1 vs#4 parallèle) + 3-4 (P0#5) ≈ **14-16 jours-homme** sur 1 dev.

---

## ⚠️ Sprint 0 — Pré-requis (1-2 jours, AVANT toute action P0)

Ces 4 quick wins n'apportent **aucune valeur user directe** mais débloquent / fiabilisent les 5 actions P0 :

### S0.1 — Factoriser helper `lib/dify.ts:chat()`
- **Source** : `services/app/src/app/api/chat/route.ts:92-108` actuellement inline.
- **Cible** : exporter une fonction `difyChat({ slug, userId, message, conversationId?, stream? }) → AsyncIterable<Event> | string`.
- **Bénéfice** : nécessaire pour P0 #4 (delegate) et utile pour P0 #3 (auditor).
- **Effort** : 0.5-1j.

### S0.2 — Standardiser contrat erreurs tools
- **Cible** : tous les `agents-tools/*/route.ts` retournent en cas d'erreur `{ error: string, hint: string, retryable: boolean, retry_after_ms?: number }`.
- **Bénéfice** : nécessaire pour P0 #5 replan (distinguer fatal vs retry). Améliore aussi UX et debug.
- **Effort** : 0.5j (18 routes × 1-2 min de relecture).

### S0.3 — Spans Langfuse tool-call
- **Constat** : aujourd'hui Langfuse loggue les traces racines `chat:<agent>` mais aucun span tool-call → visibilité 0 sur les chains.
- **Cible** : ajouter un span Langfuse autour de chaque `requireApproval()` + chaque exécution tool, avec tags `tool:<name>` `replan:<n>` `delegate:<depth>`.
- **Bénéfice** : mesurer le taux de fail/replan (essentiel pour décider Option A vs B sur P0 #5). Visibilité production permanente.
- **Effort** : 0.5j.

### S0.4 — POC sandbox runtime (bwrap vs gVisor vs nsjail)
- **Constat** : `bwrap-in-Docker` non-trivial (CAP_SYS_ADMIN, bubblewrap-suid, ou alternative).
- **Cible** : valider en J1 que sandbox marche sur xefia avec runtime choisi avant de coder le service.
- **Output** : note dans `tools/research/audit_P0_01_sandbox.md` annexe : "runtime retenu = X parce que Y".
- **Effort** : 0.5-1j.

---

## 🗓️ Plan d'attaque sprint par sprint

### Semaine 1 (5 jours) — Sprint 0 + P0 #2

| Jour | Action |
|---|---|
| J1 | S0.1 helper `difyChat()` + S0.2 contrat erreurs + S0.3 spans Langfuse |
| J1 PM | S0.4 POC sandbox runtime |
| J2-J5 | **P0 #2 HITL générique** : étendre `approval-gate.ts` (userId, auto_approve_key, is_sensitive_action), refacto `/api/approvals*` génériques, wrapper `withApprovalGate()` pour les 18 tools, classifier sensitive=true/false par tool, extracter `<ApprovalBanner>` réutilisable, page `/approvals`, étendre `AuditAction.hitl.*`. |

**Livrable Sem.1** : tous tools mutatifs gatés, UI generic, fondations propres.

### Semaine 2 (5 jours) — P0 #3 + P0 #4 en parallèle

Si 1 seul dev → séquentiel :
| Jour | Action |
|---|---|
| J6-J8 | **P0 #3 auditor** : `lib/safety-auditor.ts` qwen3:1.7b CPU, system prompt FR, wiring `requireApproval()`, JSONL `safety_audits.jsonl`, test set 20 cas (10 légitimes + 7 injections + 3 unclear). |
| J9-J10 | **P0 #4 delegate** : route `agents-tools/delegate_to_specialist/route.ts`, migration pre-prompt Concierge, migration Custom Tool Dify, UI `DelegationCard`. |

Si 2 devs → parallèle (gain 2j).

### Semaine 3 (5-6 jours) — P0 #1 sandbox

| Jour | Action |
|---|---|
| J11-J16 | **P0 #1 sandbox** : `services/sandbox/` FastAPI + runtime retenu (bwrap/gVisor), route `agents-tools/bash_exec/route.ts` (auto sensitive=true via #2), YAML OpenAPI + 2 migrations Dify (provider + pre_prompt), tests sécu (escape, OOM, network off, path traversal `session_id`). |

### Semaine 4 (3-4 jours) — P0 #5 replan

| Jour | Action |
|---|---|
| J17-J20 | **P0 #5 replan Option A** : migration `0013_concierge_replan_prompt.py` avec marker `[REPLAN-V1]` + few-shot HIGH/LOW, `lib/complexity-estimator.ts` heuristique V1, mesure via Langfuse spans (S0.3). Si % fail >30% sur tâches multi-step → escalade Option B (wrapper Next.js SSE). |

**Total** : ~17-20 jours-homme sur 4 semaines (1 dev), ou 12-15 jours (2 devs en parallèle Sem.2 + Sem.3).

---

## 🧠 Décisions architecturales à trancher AVANT de coder

| # | Décision | Options | Reco |
|---|---|---|---|
| **D1** | Sandbox runtime | (a) bwrap-in-Docker + CAP_SYS_ADMIN — (b) gVisor — (c) nsjail — (d) firejail | À décider après S0.4 POC. Si CAP_SYS_ADMIN refusé sur xefia → **gVisor** (overhead +20% mais isolation propre) |
| **D2** | State HITL | (a) filesystem JSONL — (b) SQLite — (c) Postgres | **(a) filesystem JSONL** — cohérent avec stack actuelle, 0 container ajouté, V1 simple. Migration vers SQLite/Postgres si besoin >100 pending/jour |
| **D3** | Modèle auditor | (a) qwen3:14b GPU (latence +1-3s, contend chat) — (b) qwen3:1.7b CPU (200-800ms, libère GPU) | **(b) qwen3:1.7b CPU** — recommandé par audit, libère GPU pour chat principal |
| **D4** | Replan strategy | (a) Option A prompt-only (3-4j) — (b) Option B wrapper Next.js SSE (5-7j) | **(a) Option A** d'abord, mesurer Langfuse, escalade B si fail >30% |
| **D5** | Delegate threading | (a) nouvelle conversation Dify isolée (V1 blocking string) — (b) multi-agent shared conversation (Dify Workflow Apps) | **(a) V1 blocking** — Dify ne supporte pas le partage conv cross-app. Option (b) = roadmap V2 |
| **D6** | Auditor storage | (a) JSONL `/data/safety_audits.jsonl` — (b) table DB | **(a) JSONL** — suit pattern HITL pour cohérence |
| **D7** | Tools `is_sensitive_action` classification | À figer dans une migration. Voir audit P0 #2 §3 pour la liste 18 tools | À faire en début de Sprint 1 (J2). Reviewer avec user/sécu avant. |

---

## 🟢 Quick wins découverts pendant les audits (hors P0)

- 🟢 **Banner `ConciergeApprovalBanner.tsx` réutilisable** : 165 lignes self-contained, juste renommer + retarget URL → composant `<ApprovalBanner>` générique en 1h
- 🟢 **`/api/concierge/{decide,pending}` déjà name-agnostic** côté dispatch → peuvent devenir des proxies fins vers `/api/approvals*` sans casser l'existant
- 🟢 **Pattern migration Dify mature** : `tools/migrations/0010_rag_search_tool.py` est le template à cloner pour 0013/0014/0015 (provider + tool + pre_prompt)
- 🟢 **Network Docker `aibox_net` partagé** → nouveau service sandbox plug-and-play
- 🟢 **Dify `function_call` strategy déjà active** (migration 0012) → Qwen3 14B FC natif fiable, pas besoin de fallback ReAct
- 🟢 **Markers de prompt versionnés** (`[RAG-SEARCH-V1]`, `[AGENT-RULES-V2]`) → pattern propre pour ajouter `[REPLAN-V1]` (P0 #5) et `[DELEGATE-V1]` (P0 #4)

---

## 🔴 Risques transverses identifiés

| Risque | Action concernée | Mitigation |
|---|---|---|
| Sandbox escape via CAP_SYS_ADMIN | P0 #1 | POC S0.4 + audit sécu indépendant avant prod |
| Faux positifs auditor sur Qwen3 1.7B | P0 #3 | Test set 20 cas mesurés ; fallback `unclear` → toujours forcer pending |
| Récursion infinie delegate | P0 #4 | MAX_DEPTH=2 + max 3 délégations/conversation + refus self-delegation |
| Boucle infinie replan | P0 #5 | MAX_REPLANS=3 dur + budget tokens via Langfuse |
| Fuite secrets dans context inbound | P0 #3 (en partie) | Auditor blinde mais ne couvre pas tout — créer `lib/secrets-redact.ts` inbound (à ajouter dans P2) |
| UI fatigue HITL si beaucoup de pending | P0 #2 | Auto-approve key `(exec_id, tool_name)` + page `/approvals` batch |
| Coût tokens x3-5 sur replan | P0 #5 | Pre-routing complexity LOW skip plan ; mesure Langfuse |
| Visibilité 0 sur chains si on ne fait pas S0.3 | P0 #5 mesure + debug général | S0.3 obligatoire avant P0 #5 |

---

## 🎬 Ordre d'attaque final recommandé

```
┌─────────────────────────────────────────────────────────────────┐
│ Sprint 0 — Pré-requis (1-2j)                                    │
│  ├── S0.1 lib/dify.ts:chat() helper                             │
│  ├── S0.2 contrat erreurs tools {error, hint, retryable}        │
│  ├── S0.3 spans Langfuse tool-call                              │
│  └── S0.4 POC sandbox runtime → décision D1                     │
└─────────────────────────────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Sprint 1 — P0 #2 HITL générique (3.5j)                          │
│  ├── refacto approval-gate.ts (userId/auto_approve/sensitive)   │
│  ├── routes /api/approvals* génériques                          │
│  ├── wrapper withApprovalGate() pour 18 tools                   │
│  ├── classification sensitive=true/false (D7)                   │
│  └── UI <ApprovalBanner> générique + page /approvals            │
└─────────────────────────────────────────────────────────────────┘
                                ▼
                    ┌───────────┴───────────┐
                    ▼                       ▼
┌───────────────────────────────┐ ┌────────────────────────────────┐
│ Sprint 2a — P0 #3 auditor     │ │ Sprint 2b — P0 #4 delegate     │
│ (2.5j)                        │ │ (2j)                           │
│ ├── qwen3:1.7b CPU            │ │ ├── route delegate_to_*        │
│ ├── lib/safety-auditor.ts     │ │ ├── migration pre-prompt       │
│ ├── wiring requireApproval()  │ │ ├── migration Custom Tool Dify │
│ ├── safety_audits.jsonl       │ │ └── UI DelegationCard          │
│ └── test set 20 cas           │ │                                │
│ ⚠️ après P0 #2                │ │ ✅ indépendant (parallélisable)│
└───────────────────────────────┘ └────────────────────────────────┘
                    └───────────┬───────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Sprint 3 — P0 #1 sandbox (5-6j)                                 │
│  ├── services/sandbox/ FastAPI + runtime D1                     │
│  ├── route bash_exec (auto sensitive=true via #2)               │
│  ├── 2 migrations Dify (provider + pre_prompt)                  │
│  └── tests sécu (escape/OOM/network/path-traversal)             │
└─────────────────────────────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Sprint 4 — P0 #5 replan Option A (3-4j)                         │
│  ├── migration 0013 [REPLAN-V1] + few-shot HIGH/LOW             │
│  ├── lib/complexity-estimator.ts heuristique                    │
│  └── mesure Langfuse → décide Option B si fail >30%             │
└─────────────────────────────────────────────────────────────────┘
```

**Durée totale** :
- 1 dev séquentiel : **~17-20 jours-homme** sur 4 semaines
- 2 devs (parallèle Sprint 2a/2b) : **~13-15 jours** sur 3 semaines
- 1 dev avec multi-worktree (Sprint 2a/2b en alternance) : ~14-16 jours

---

## ✅ Prochains pas

Quand tu valides ce plan :

1. **Trancher les 7 décisions architecturales (D1-D7)** — 30 min de discussion
2. **Lancer Sprint 0** dans une nouvelle session (1-2j) — peut être fait par 1 agent autonome avec le `MASTER-PROMPT.md` adapté en mode "Sprint 0 only"
3. **Sprint 1 (P0 #2)** → critique, 1 agent + review user à la fin
4. **Sprints 2a/2b** → parallélisables avec 2 worktrees
5. **Sprint 3 (P0 #1)** → demande validation sécu + POC validé S0.4
6. **Sprint 4 (P0 #5)** → mesure Langfuse en cours d'implémentation

À chaque fin de sprint : commit, branche, PR draft, review user, **STOP**.

---

## 📚 Index des audits détaillés

| Audit | Fichier |
|---|---|
| P0 #1 sandbox | [audit_P0_01_sandbox.md](audit_P0_01_sandbox.md) |
| P0 #2 HITL | [audit_P0_02_hitl.md](audit_P0_02_hitl.md) |
| P0 #3 auditor | [audit_P0_03_auditor.md](audit_P0_03_auditor.md) |
| P0 #4 delegate | [audit_P0_04_delegate.md](audit_P0_04_delegate.md) |
| P0 #5 replan | [audit_P0_05_replan.md](audit_P0_05_replan.md) |
