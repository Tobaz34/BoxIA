# 🧠 Décisions architecturales — P0 BoxIA v2 OSS-inspired

> Validé par l'utilisateur le **2026-05-05** suite aux audits des 5 actions P0.
> Ces décisions sont **load-bearing** pour Sprint 0 → Sprint 4. Toute déviation doit être
> discutée et journalisée ici.
>
> **⚙️ Statut d'exécution** (mise à jour 2026-05-05 après session autonome) :
> voir [DONE.md](DONE.md) pour le détail commit-par-commit.
>
> | Sprint | Statut | Notes |
> |---|---|---|
> | Sprint 0 S0.1 (helper Dify) | ✅ livré (commit `a41ae10`) | difyChatStream + difyChatBlocking |
> | Sprint 0 S0.2 (contrat erreurs) | ✅ livré (commits `e015a7d` + `e413ee4`) | Helper + 15/18 routes migrées |
> | Sprint 0 S0.3 (Langfuse spans) | 🟡 helpers livrés (commit `e015a7d`), instrumentation routes pending | logToolCall + startToolTrace dispo |
> | Sprint 0 S0.4 (POC gVisor) | 🔴 bloqué — exige xefia + sudo | À tester avant P0 #1 |
> | Sprint 1 P0 #2 HITL | 🟡 partie 1/3 livrée (commit `288a5a7`) | extension approval-gate + tool-meta ; UI + routes génériques + migration 18 routes pending |
> | Sprint 2a P0 #3 auditor | ⏸️ pas démarré | dépend P0 #2 |
> | Sprint 2b P0 #4 delegate | 🟡 partie 2/4 livrée (commit `7233d41`) | route + migration 0013 prompt ; OpenAPI YAML 0014 + UI Card pending |
> | Sprint 3 P0 #1 sandbox | ⏸️ pas démarré | dépend S0.4 + P0 #2 |
> | Sprint 4 P0 #5 replan | ⏸️ pas démarré | dépend P0 #4 + Langfuse spans wired |

---

## D1 — Sandbox runtime : **gVisor (`runsc`)**

**Action concernée** : P0 #1 (`aibox-sandbox` + `bash_exec`).

**Décision** : utiliser **gVisor** (`runsc`) comme runtime du container `aibox-sandbox`.

**Justification** :
- Isolation de référence (utilisé par Google Cloud Run, GKE Sandbox).
- Kernel userspace réimplémenté → **pas besoin de `CAP_SYS_ADMIN` ni de `bubblewrap-suid`**, ce qui évite la modif privilèges Docker daemon sur xefia.
- Overhead CPU ~+20% acceptable vu l'usage TPE/PME (rare bash_exec, pas du tout du calcul lourd permanent).
- Maturité production.

**Plan B** : si gVisor refuse de tourner sur le kernel xefia (`runsc` exige ptrace + seccomp parfois bloqués), fallback sur **`nsjail`** + namespace user.

**POC obligatoire** : **Sprint 0 — S0.4** (J1) avant de coder le service. Output : note dans `tools/research/audit_P0_01_sandbox.md` annexe "runtime retenu = X".

---

## D2 — Backend state HITL : **filesystem JSONL**

**Action concernée** : P0 #2 (HITL générique).

**Décision** : `pending_human_review` stocké en `/data/pending-reviews.jsonl` + un fichier `/data/concierge-approvals/<uuid>.json` par pending (pattern actuel).

**Justification** :
- Cohérence stack actuelle : `lib/app-audit.ts` → `/data/audit.jsonl`, `lib/approval-gate.ts` → `/data/concierge-approvals/<id>.json`.
- **Zéro container ajouté**, zéro dépendance Node nouvelle. App Next.js BoxIA n'a pas Postgres dans `package.json`.
- Concurrence : `proper-lockfile` ou atomic rename (write tmp + rename) — suffisant pour <50 pending/jour.
- Reset client cohérent (`reset-as-client.sh` purge `/data/`).

**Plan B** : passer à SQLite (`/data/aibox.db`) si volume >50 pending/jour réguliers. Migration "à chaud" via `tools/migrations/00XX_jsonl_to_sqlite.py` quand le besoin émerge. **Pas Postgres** (overkill pour cet état).

---

## D3 — Modèle auditor LLM : **qwen3:1.7b CPU**

**Action concernée** : P0 #3 (Auditor 2-pass anti-prompt-injection).

**Décision** : déployer un second modèle Ollama **`qwen3:1.7b`** sur **CPU** dédié à l'auditor.

**Justification** :
- Latence 200-800ms par appel → acceptable pour un check pré-tool.
- Libère le **GPU** (qwen3:14b) pour le chat principal (12 GB tight, on évite la contention).
- Faux-positifs gérés par fallback : verdict `unclear` → forcer `pending` (l'opérateur humain reste le dernier juge).

**Plan B** : si le test set 20 cas (J6 du Sprint 2a) montre >40% de faux positifs, passer à **qwen3:4b CPU** (latence ~600ms-1.5s, qualité meilleure). Si toujours insuffisant, qwen3:8b sur GPU partagé.

**Test set obligatoire** : 20 cas (10 légitimes + 7 injections connues + 3 ambiguës) à mesurer avant wiring final dans `requireApproval()`.

---

## D4 — Stratégie replan : **Option A prompt-only, escalade conditionnée**

**Action concernée** : P0 #5 (Replan dynamique + complexity routing).

**Décision** : démarrer **Option A** en Sprint 4.

- Migration `tools/migrations/00XX_concierge_replan_prompt.py` avec marker `[REPLAN-V1]` dans le pre_prompt Concierge.
- Few-shot HIGH/LOW dans le prompt pour amorcer la complexity classification.
- `lib/complexity-estimator.ts` heuristique en V1 (regex + length + tool-mentions count).
- Mesure via Langfuse spans (Sprint 0 — S0.3 pré-requis).

**Critère d'escalade vers Option B** (wrapper Next.js SSE) :
- Si `% succès direct + % succès après replan` < 70% sur les tâches multi-step (mesuré sur 1 semaine de prod via Langfuse) → escalade Option B (5-7j additionnels).
- Si Qwen3 14B FC ne respecte pas le format `[REPLAN-V1]` >30% du temps → idem.

**Sortie attendue Sprint 4** : taux de succès mesuré + décision A vs B documentée dans `audit_P0_05_replan.md` annexe.

---

## D5 — Threading delegate : **Option A — nouvelle conversation Dify isolée, blocking V1**

**Action concernée** : P0 #4 (`delegate_to_specialist`).

**Décision** : le specialist reçoit `(prompt enrichi, contexte resumé en string)`, retourne sa réponse en string finale au Concierge.

**Justification** :
- Dify ne supporte pas le partage de conversation cross-app — vérifié pendant l'audit P0 #4.
- L'option B (Workflow App Dify single-flow avec sous-noeuds par specialist) est une refacto majeure (5-7j) qui n'apporte pas de valeur user immédiate.
- Mitigation perte contexte : (1) le Concierge fournit un résumé explicite, (2) MAX_DEPTH=2, (3) max 3 délégations par conversation.

**Garde-fous V1** :
- `MAX_DEPTH=2` en dur (refus si header `X-Delegation-Depth` > 2).
- Refus self-delegation (`if slug === current_agent_slug: 400`).
- Timeout 60s par sub-call.
- Tracker tokens via Langfuse — abort si delegation > 50% budget initial conversation.

**Roadmap V2** : Option C (Workflow App single-flow) à reconsidérer quand (a) on a un cas business avec >5 délégations enchaînées récurrentes, ou (b) Dify upstream supporte conv shared.

---

## D6 — Storage auditor (safety_audits) : **JSONL**

**Action concernée** : P0 #3 (Auditor).

**Décision** : `/data/safety_audits.jsonl` avec rotation hebdomadaire via `logrotate` (cron).

**Justification** :
- Alignement avec D2 (HITL filesystem JSONL) → stack cohérente.
- Rotation/archivage simple (logrotate).
- Si on veut un jour query SQL → import JSONL → ClickHouse/SQLite ad-hoc.

---

## D7 — Classification `is_sensitive_action` des 18 tools

**Action concernée** : P0 #2 (HITL — figer la liste en début Sprint 1, J2).

| Tool | `is_sensitive_action` | Raison |
|---|---|---|
| `web_search` | ❌ false | lecture web ; output réinjecté au LLM → couvert par auditor (D3) |
| `gmail_search` | ❌ false | lecture ; output couvert par auditor |
| `gmail_read_inbox` | ❌ false | idem |
| `gmail_get_thread` | ❌ false | idem |
| `outlook_search` | ❌ false | idem |
| `outlook_read_inbox` | ❌ false | idem |
| `outlook_get_message` | ❌ false | idem |
| `calendar_today` | ❌ false | lecture |
| `calendar_find_free_slot` | ❌ false | lecture |
| `system_health` | ❌ false | lecture |
| `list_connectors` | ❌ false | lecture |
| `list_marketplace_agents_fr` | ❌ false | lecture |
| `list_marketplace_workflows` | ❌ false | lecture |
| `deep_link` | ❌ false | génère lien, pas d'effet de bord |
| `rag_search` | ❌ false | lecture ; output couvert par auditor |
| `install_workflow` | ✅ **true** | mutation système (déjà gaté aujourd'hui) |
| `install_agent_fr` | ✅ **true** | mutation système (déjà gaté aujourd'hui) |
| `bash_exec` (futur P0 #1) | ✅ **true** | exécution code, RCE potentielle |
| `delegate_to_specialist` (futur P0 #4) | ❌ false | délégation interne ; le specialist est lui-même gaté |

**Tools mutatifs futurs anticipés** (P1+) — tous `is_sensitive_action: true` :
- `gmail_send`, `outlook_send`
- `calendar_create_event`, `calendar_delete_event`, `calendar_update_event`
- `oauth_revoke`
- `delete_document`, `delete_email`
- `n8n_run_workflow` (mutation cross-system)
- `bash_exec` (déjà listé P0)
- `pennylane_create_invoice`, `odoo_create_partner` (futurs connecteurs CRM/compta)

**Règle générale** : tout tool qui (a) écrit, (b) supprime, (c) envoie un message externe, (d) exécute du code, (e) modifie un secret/permission → `is_sensitive_action: true`.

---

## 🔁 Quand modifier ce document

- **Réviser D1 (gVisor)** uniquement après le POC Sprint 0 — S0.4. Si gVisor échoue → fallback nsjail, mettre à jour cette section.
- **Réviser D3 (auditor model)** après mesure du test set 20 cas (Sprint 2a J6) — si faux-positifs >40% → bump à qwen3:4b ou 8b.
- **Réviser D4 (replan)** après mesure Langfuse Sprint 4 — si succès <70% → escalade Option B.
- **D2, D5, D6, D7** ne devraient pas bouger sauf cas business inattendu.

---

## 📚 Références

- Plan d'attaque détaillé : [AUDIT-P0-SUMMARY.md](AUDIT-P0-SUMMARY.md)
- Audits par action :
  - P0 #1 → [audit_P0_01_sandbox.md](audit_P0_01_sandbox.md)
  - P0 #2 → [audit_P0_02_hitl.md](audit_P0_02_hitl.md)
  - P0 #3 → [audit_P0_03_auditor.md](audit_P0_03_auditor.md)
  - P0 #4 → [audit_P0_04_delegate.md](audit_P0_04_delegate.md)
  - P0 #5 → [audit_P0_05_replan.md](audit_P0_05_replan.md)
- Synthèse cross-projets OSS : [00_SYNTHESE.md](00_SYNTHESE.md)
- Master prompt agent : [MASTER-PROMPT.md](MASTER-PROMPT.md)
