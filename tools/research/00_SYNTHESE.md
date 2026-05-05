# 🧪 Synthèse — 6 projets OSS analysés vs BoxIA

> Rapport rédigé le **2026-05-05** après deep-dive parallèle de 6 projets agents IA open source.
> Sources : 6 rapports détaillés `01_*.md` à `06_*.md` dans ce dossier.
> Auteur : session `eager-buck-3b6e79`.
>
> ⚠️ **Mise à jour 2026-05-05 (post-audits)** : voir [AUDIT-P0-SUMMARY.md](AUDIT-P0-SUMMARY.md) pour les corrections d'hypothèses (18 tools pas 17, agents = `general/vision/accountant/hr/support/concierge`, pas de Postgres dans Next.js BoxIA, `requireApproval()` déjà générique côté params, etc.) et le plan d'attaque sprint par sprint avec ordre P0 corrigé (`Sprint 0 → P0 #2 → P0 #3 + #4 parallèle → P0 #1 → P0 #5`).

---

## 📊 TL;DR

**6 projets analysés** : AutoGPT (184k★, MIT/Polyform Shield), Agent Zero (MIT, commercial), Observer AI (MIT, micro-agents écran), OpenClaw (assistant IA personnel steipete), AgenticSeek (GPL-3.0 ⚠️), Local Operator (MIT, desktop).

**Diagnostic BoxIA** :
- ✅ **Structurellement supérieur** sur 5 axes : multi-user RBAC + Authentik OIDC, approval-gate, self-update OTA, i18n FR/EN, migrations DB versionnées + lock multi-session, connecteurs FR (Pennylane/Odoo/HubSpot/GLPI).
- 🔴 **Gap critique** : **zéro automation passive** (boucle / scheduling / replan dynamique côté agent). Tous nos pairs ont au moins 1 primitive de ce type. Notre Concierge fait du tool-call **one-shot** et plante au premier échec.
- 🔴 **Gap critique #2** : **6 agents Dify isolés** (zéro inter-comm). 3 projets sur 6 ont une primitive `delegate_to_agent()` qui transforme les silos en équipe coordonnée.
- 🟡 **Gap notable** : **pas de sandbox d'exécution code** côté Concierge. Bloque toute la famille "tâches IT" (génère un PDF, analyse un CSV, runner un script ad-hoc).
- 🟢 **Vols rapides à fort ROI** : `<thinking>` stripper robuste (0.5j), BM25 reranking RAG (1-2j), PII sanitize pré-publish marketplace (1j).

**3 priorités absolues** (détaillées en §Roadmap) :
1. **Sandbox `aibox-sandbox`** + HITL générique étendu (différenciateur RGPD)
2. **Multi-agent delegate + replanning dynamique** (tool `delegate_to_specialist` + `update_plan`)
3. **Scheduling/loop natif côté LLM** (3 tools `schedule_*` + boucle passive avec change detection)

---

## 🔄 Matrice de patterns (qui a quoi)

| Pattern / Capability | AutoGPT | Agent Zero | Observer | OpenClaw | AgenticSeek | LocalOp | **BoxIA** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Multi-user / RBAC** | ✅ tier+rate | ❌ mono | ❌ mono | ❌ mono | ❌ mono | ❌ mono | ✅✅ |
| **Approval gate / HITL** | ✅✅ générique table | ❌ | ❌ | ⚠️ doctor | ❌ | ✅ 2-pass | ✅ partiel (Concierge only) |
| **Sandbox code exec** | ✅✅ E2B+bwrap | ✅ Docker 2 venv | ❌ (browser only) | — | 🔴 exec direct | 🔴 exec direct | ❌ |
| **Boucle passive / loop** | ❌ (DAG event) | ❌ | ✅✅ change-detect | ❌ | ❌ | ❌ | ❌ |
| **Scheduling natif côté LLM** | (graph cron) | ⚠️ scheduler ext | (loop = équiv) | — | ❌ | ✅✅ 3 tools | ❌ (uniquement n8n cron) |
| **Replan dynamique** | ❌ | ✅ subordinate | ❌ | ❌ | ✅✅ update_plan | ❌ | ❌ |
| **Multi-agent delegate** | (graph nodes) | ✅✅ recursive | ✅ $MEMORY@id | ✅ skills | ✅ router | ✅✅ delegate | ❌ |
| **Persona/manifest fichier** | ✅ Block schema | ✅ .md inherit | ❌ | ✅✅ SOUL/AGENTS.md | ❌ | ⚠️ agent.yml | ❌ (en DB Dify) |
| **Marketplace store mature** | ✅✅ hybrid search+billing | ⚠️ plugins | ⚠️ INSERT OR REPLACE | ✅✅ doctor+compat | ❌ | ⚠️ Radient hub | ⚠️ 4 catalogues parallèles |
| **PII scrub pré-publish** | ✅ AutoMod | ❌ | ✅ regex 60 lignes | ✅ doctor | ❌ | ❌ | ✅ outbound only |
| **Self-update OTA** | rolling docker | ✅ self_update.py | ✅ Tauri auto | — | ❌ | ❌ | ✅✅ systemd watcher |
| **i18n natif** | ❌ EN | ❌ EN | partiel | ❌ EN | partiel | ❌ EN | ✅✅ FR/EN |
| **Connecteurs métier FR** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅✅ |
| **Observabilité** | ✅ Sentry+Prom+Langfuse | partiel | ✅ Posthog+Sentry | ✅ doctor | ❌ | partiel | ✅ Langfuse+audit |
| **Knowledge graph LT** | ✅ Graphiti+FalkorDB | ✅ FAISS+enriched | ❌ | ❌ | ❌ | ⚠️ jsonl flat | ⚠️ mem0 flat |
| **`<thinking>` stripper robuste** | ✅✅ depth+chunk-safe | ❌ | — | — | ❌ | — | ⚠️ basique `<think>` |
| **Streaming secrets filter** | ✅ outbound | ✅✅ SSE inbound+outbound | — | — | ❌ | ❌ | ⚠️ outbound only |
| **Browser agent autonome** | ⚠️ block | ✅ Playwright | ✅✅ vision écran | — | ✅ Selenium | ⚠️ playwright | ❌ (SearxNG seul) |
| **Auditor 2-pass anti-injection** | partiel | ❌ | ❌ | — | ❌ | ✅✅ SafetyCheck | ❌ |

**Légende** : ✅✅ référence du marché — ✅ correct — ⚠️ partiel/incomplet — ❌ absent — 🔴 anti-pattern (à fuir)

---

## 🎯 Roadmap consolidée — 18 actions classées par ROI

### 🔥 P0 — À planifier en priorité (différenciateurs marché)

| # | Action | Sources d'inspiration | Coût | Bénéfice |
|---|---|---|---|---|
| **1** | **`aibox-sandbox`** : nouveau service `bwrap` (ou e2b self-host) + tool `bash_exec` côté Concierge protégé par approval-gate. Permet "génère un PDF", "analyse ce CSV", "calcule X depuis le FEC", "appelle une API exotique" | AutoGPT `backend/copilot/tools/e2b_sandbox.py` + `bash_exec.py` ; Agent Zero `_code_execution` plugin | **L (1-2 sem)** | Débloque la moitié des tâches IT qu'un patron TPE ne sait pas exprimer en n8n. **ROI x10**. |
| **2** | **HITL générique** : table `PendingHumanReview` + flag `is_sensitive_action` sur tous les tools mutatifs (`send_email`, `delete_*`, `n8n_run_workflow`, OAuth revoke) + auto-approve key `(exec_id, tool_id)`. Étendre `lib/approval-gate.ts` au-delà du Concierge | AutoGPT `backend/data/human_review.py` + `backend/blocks/_base.py:676-740` | **M (3-5j)** | Différenciateur **RGPD/CNIL** face aux US. Conformité native. **ROI x5**. |
| **3** | **Auditor LLM 2-pass** : 2nd appel qwen3 (déjà chargé GPU) avec `SafetyCheckSystemPrompt` indépendant qui audite chaque tool-call sortant pour prompt-injection (utile quand l'agent lit un email/doc external) | LocalOp `prompts.py:SafetyCheckSystemPrompt` L1207 | **S (1j)** | Blinde contre injection email/doc, pas juste clics distraits. Couplé avec #2. |
| **4** | **Tool `delegate_to_specialist(slug, prompt)`** sur le Concierge : POST sur Dify completion endpoint de l'agent ciblé, résultat injecté en contexte. Borné par `MAX_DEPTH=2` + budget tokens via Langfuse | LocalOp `executor.py:2182` ; Agent Zero `tools/call_subordinate.py` | **S (1-2j)** | Nos 6 agents Dify deviennent une **équipe** coordonnée par le général. Routage image→vision sans hack. |
| **5** | **Replan dynamique** : sur tool-call qui échoue, le Concierge demande au LLM de réécrire le JSON `plan` à partir de l'étape qui plante (au lieu de planter). Few-shot HIGH/LOW complexity en pré-routing | AgenticSeek `planner_agent.py:184 update_plan()` + `router.py:401 estimate_complexity` | **S (1-2j)** | Résilience tâches multi-step ("trouve facture 2024 X dans Pennylane → télécharge PDF → envoie mail"). |

### 🚀 P1 — Très impactant (sprints suivants)

| # | Action | Sources | Coût | Bénéfice |
|---|---|---|---|---|
| **6** | **Scheduler natif côté LLM** : 3 tools `schedule_task` / `stop_schedule` / `list_schedules` + APScheduler runner + table Postgres + UI listing. Le Concierge planifie lui-même | LocalOp `scheduler_service.py` + `types.py:Schedule:393` | **M (2-3j)** | "Envoie-moi un résumé Outlook tous les matins à 8h" devient natif sans cliquer dans n8n. |
| **7** | **Loop passive + change detection** : Postgres table `agents_watchers` + sensors plugins (`$EMAIL_INBOX_NEW`, `$ODOO_INVOICES_DUE`, `$DIFY_AGENT@id`) avec dHash/Levenshtein/sim avant LLM call | Observer `app/src/utils/main_loop.ts` + `change_detection.ts` | **L (5-7j)** | Famille "agent qui se réveille seul" : alerte commercial, résumé matinal, watchdog factures impayées. |
| **8** | **Manifest unifié `boxia.plugin.json`** + `aibox doctor` CLI : unifier les 4 marketplaces actuels (Dify-FR / n8n / MCP / cloud-providers) sous un seul schema validable + 13 capabilities typées + compat signals UI (`config valid` / `legacy warning` / `hard error`) | OpenClaw `openclaw.plugin.json` + `bin/openclaw doctor` | **L (5-7j)** | Empêche la divergence des 4 catalogues. Interop gratuite avec Codex/Claude/Cursor (`SKILL.md` AgentSkills standard). |
| **9** | **PII sanitizer marketplace pré-publish** : reprendre `code_sanitizer.ts` 60 lignes regex (emails, IBAN, IP, paths) côté `services/app/src/lib/dify-marketplace.ts` + `boxia-fr-templates.ts` | Observer `app/src/utils/code_sanitizer.ts` | **S (1j)** | Évite fuite secrets dans agents publiés. Aujourd'hui on scrub seulement outbound LLM. |
| **10** | **Personas user-éditables fichiers `.md`** : exposer les pre_prompts Dify dans 4 onglets `/agents/[slug]/configure` (`SOUL.md` rôle, `IDENTITY.md` ton, `USER.md` user, `AGENTS.md` plan) + versionning Git | OpenClaw `SOUL.md`/`AGENTS.md`/`USER.md`/`IDENTITY.md` ; Agent Zero `prompts/agent.system.main.role.md` + `{{include}}` | **M (3-5j)** | UX énorme : aujourd'hui les prompts sont enterrés dans Dify DB. Versionable, partageable. |

### 🎨 P2 — Améliorations qualité (sprint backlog)

| # | Action | Sources | Coût | Bénéfice |
|---|---|---|---|---|
| **11** | **`<thinking>` stripper robuste** : depth counter pour balises imbriquées + safe sur frontière de chunk SSE. Remplace `lib/strip-think.ts` qui ne gère que `<think>` simple | AutoGPT `backend/copilot/thinking_stripper.py` | **S (0.5-1j)** | Élimine bug récurrent de pollution UI quand qwen3 émet `<think>...<internal>...</internal>...</think>`. |
| **12** | **BM25 reranking sur RAG Qdrant** : combiner score vectoriel + rank_bm25 lexical | AutoGPT `backend/api/features/store/hybrid_search.py:bm25_rerank` | **S (1-2j)** | Qualité réponses RAG (en particulier sur termes métier rares — SIREN, codes APE). |
| **13** | **StreamingSecretsFilter inbound + outbound** sur SSE chat : bloquer fuite credentials même si le LLM les régurgite | Agent Zero `extensions/python/.../streaming_secrets_filter.py` ; format `§§secret(KEY)` | **S (1-2j)** | Couvre fuite cas-limite que `lib/secrets-redact.ts` actuel n'attrape pas (multi-chunk). |
| **14** | **ProviderBuilder fluent TS** : refondre `lib/connectors.ts` + `lib/oauth-providers.ts` en `defineProvider("cegid").withOAuth().withApiKey().withWebhook()` | AutoGPT `backend/sdk/builder.py` + `backend/sdk/provider.py` | **M (3-5j refacto + 1j/connecteur)** | Scaler le catalogue FR à 15-20 connecteurs en 1 mois (Cegid, Sage, EBP, Quadratus, MyUnisoft) au lieu de 3-4j chacun. |
| **15** | **Memory compression long-context** : LED-Longformer ou résumé LLM pour convs >30 messages (avant saturation 32k tokens qwen3) | AgenticSeek `memory.py compression` | **M (2j)** | Conversations longues qui saturent aujourd'hui le contexte général. |
| **16** | **Onboarding XP/milestones** : score sur `(premier login, premier connecteur, premier agent installé, premier workflow run)` → personnalisation suggestions UI | AutoGPT `backend/data/onboarding.py` | **S (1j)** | Page `/onboarding` actuelle est statique. |

### 🔭 P3 — À surveiller (pas d'action immédiate)

| # | Action | Sources | Trigger pour activer |
|---|---|---|---|
| **17** | **Browser agent Playwright** (`services/browser-agent/`) avec protocole textuel `Action: NAVIGATE/GO_BACK [input](value)` | AgenticSeek `browser_agent.py:92` | Quand un client demande "lis mon portail URSSAF / DGFiP / impots.gouv". |
| **18** | **Knowledge graph LT** : passer mem0 flat → Graphiti/neo4j pour relier "client X = SIREN Y = facture Z = relance K" | AutoGPT `backend/copilot/graphiti/` | Quand >50 utilisateurs et >10 connecteurs actifs. Avant on n'a pas la densité de signal. |
| **19** | **WebPush VAPID notifications** | AutoGPT `backend/data/push_subscription.py` + `notifications/push_sender.py` | Tier pme-plus, pour alerter sur fin de workflow long. |
| **20** | **Crédits + Stripe 6 types coût** | AutoGPT `backend/data/credit.py` + `executor/billing.py` | Si on passe d'appliance vendue à BoxIA Cloud BYOC. |
| **21** | **Builder visuel xyflow** | AutoGPT `frontend/src/app/(platform)/build/` | Si on cible un jour des power-users TPE qui veulent autre chose que n8n. Probablement jamais. |

---

## 🔴 Anti-patterns transverses (pièges identifiés à NE PAS reproduire)

| Anti-pattern | Vu chez | Notre situation |
|---|---|---|
| `exec()` Python direct dans backend partagé sans isolation | AgenticSeek (`PyInterpreter`), LocalOp (`executor.py`) | ❌ pas le cas (on n'a pas de code exec — voir P0 #1 pour ajouter avec sandbox propre) |
| Checklist regex `if "rm" in cmd` comme "sandbox" | AgenticSeek | n/a |
| `context.pkl` Python pickle importé au démarrage = RCE | LocalOp | n/a |
| CORS `*` sans auth | AgenticSeek, LocalOp | ✅ on a Authentik partout |
| Credentials YAML en clair sur disque | LocalOp (`credentials.yml`) | ✅ on chiffre déjà avec master key |
| Mount Docker socket dans le compose | Observer (Tauri/desktop) | ✅ pas le cas |
| `INSERT OR REPLACE` sans versioning sur marketplace SQLite | Observer | ⚠️ à vérifier sur `dify-marketplace.ts` et `boxia-fr-templates.ts` |
| Block UUID hardcodés dans le code | AutoGPT | ✅ on n'a pas ce pattern |
| Single-user implicite (pas de RBAC) | OpenClaw, Agent Zero, LocalOp, Observer | ✅✅ on a Authentik + RBAC connecteur |
| **License `Polyform Shield`** (interdit revente cloud concurrente) | AutoGPT `autogpt_platform/` | ⚠️ **lecture-only** : tout ce qu'on copie doit être ré-implémenté depuis l'idée, pas le code |
| **License `GPL-3.0`** (contagieuse) | AgenticSeek | ⚠️ **réimplémenter, jamais vendoriser** |
| Stack lourde 20+ services empilés (Supabase + RabbitMQ + FalkorDB + ClamAV…) | AutoGPT | ⚠️ on est déjà à 33 containers — éviter d'ajouter RabbitMQ + FalkorDB en plus |
| `DEFAULT_TIER=PRO` en bêta (commenté volontaire mais piège fork) | AutoGPT | ✅ on a `tier free/pme/pme-plus` propre |
| Marketplace sans pré-publish PII scrub | Observer (corrigé), AgenticSeek, LocalOp | ⚠️ à corriger (P1 #9) |

---

## 💪 Avantages structurels BoxIA à préserver

1. **Multi-user RBAC + Authentik OIDC** — TOUS les autres sont mono-user. C'est notre différenciateur B2B PME.
2. **Approval-gate déjà présent** (`lib/approval-gate.ts`) — à étendre, pas à créer.
3. **Self-update OTA via systemd watcher + bouton UI** — AutoGPT a juste rolling docker tags, Observer a Tauri auto. On est seul à avoir l'**appliance auto-updatable** côté serveur Linux.
4. **Migrations DB versionnées + lock multi-session** (`tools/deploy-to-xefia.sh`, `tools/migrations/`) — aucun de nos pairs n'a un workflow aussi rigoureux pour reset client + rejouer migrations.
5. **i18n natif FR/EN** — AutoGPT (lib leader) est anglais-only.
6. **Connecteurs métier FR** (Pennylane / Odoo / HubSpot / GLPI / FEC import) — vide complet chez tous les concurrents OSS.
7. **Stack 33 containers organisée** par domaine (`services/{agents-autonomous,authentik,connectors,dify,...}/docker-compose.yml`) — séparation propre vs AutoGPT qui mélange tout.
8. **Audit log + RGPD + PII scrub FR (7 patterns)** — déjà au-dessus du marché.

**À NE PAS migrer** vers les approches concurrentes :
- Ne pas adopter le modèle "agent code-natif" d'Agent Zero (Python REPL + shell). Notre `tool-natif via Dify Custom Tools curatés` est plus sûr et plus fiable pour Qwen3 14B.
- Ne pas absorber le builder visuel xyflow d'AutoGPT — overkill pour notre cible "comptable / réceptionniste".
- Ne pas vendoriser AutoGPT (`autogpt_platform/` Polyform Shield) ni AgenticSeek (GPL-3.0). Lire, comprendre, **ré-implémenter depuis l'idée**.

---

## 🗺️ Schéma cible BoxIA "v2 OSS-inspired"

```
┌─────────────────────────────────────────────────────────────────────┐
│   UI Next.js  (aibox-app)                                           │
│   • /agents/[slug]/configure  ← 4 onglets persona .md (OpenClaw)    │
│   • /watchers ← NEW  loop-based agents UI (Observer)                │
│   • /schedules ← NEW  agent-scheduled tasks UI (LocalOp)            │
│   • /sandbox-jobs ← NEW  bash_exec history (AutoGPT)                │
│   • /marketplace  ← unifié boxia.plugin.json (OpenClaw)             │
└─────────────────────────────────────────────────────────────────────┘
              │ SSE (with StreamingSecretsFilter inbound+outbound)
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│   Concierge agent (Dify, qwen3:14b)                                 │
│   ├── tools mutatifs   ← flag is_sensitive_action  (AutoGPT)        │
│   │   └── HITL gate   ← table PendingHumanReview                    │
│   │       └── auditor 2-pass  ← qwen3 SafetyCheck (LocalOp)         │
│   ├── tool delegate_to_specialist(slug)  ← MAX_DEPTH=2  (LocalOp)   │
│   ├── tool schedule_task / stop / list  ← APScheduler  (LocalOp)    │
│   ├── tool bash_exec  ← aibox-sandbox bwrap  (AutoGPT)              │
│   ├── plan replanifier  ← update_plan() on fail  (AgenticSeek)      │
│   └── pre-routing complexity HIGH/LOW  ← circuit breaker            │
└─────────────────────────────────────────────────────────────────────┘
              │
   ┌──────────┼──────────┬──────────────┬──────────────┐
   ▼          ▼          ▼              ▼              ▼
 [Vision]  [Compta]  [Juridique]  [Marketing]   [Watchers loop ← NEW]
                                                  • $EMAIL_INBOX_NEW
                                                  • $ODOO_INVOICES_DUE
                                                  • $DIFY_AGENT@id
                                                  (change detection avant LLM)

[NEW services]
  services/sandbox/    bwrap / e2b self-host (Concierge bash_exec)
  services/watchers/   loop runner + sensors + change-detect (Observer-like)
  services/scheduler/  APScheduler runner + table Postgres + UI

[Améliorations existantes]
  services/app/src/lib/strip-think.ts        ← stripper robuste (AutoGPT)
  services/app/src/lib/approval-gate.ts      ← générique tous tools (AutoGPT)
  services/app/src/lib/connectors.ts         ← ProviderBuilder fluent (AutoGPT)
  services/app/src/lib/qdrant-client.ts      ← BM25 hybrid (AutoGPT)
  services/app/src/lib/dify-marketplace.ts   ← code_sanitizer pre-publish (Observer)
  services/app/src/lib/boxia-fr-templates.ts ← idem
```

---

## 📚 Index des rapports détaillés

| # | Projet | Rapport | License | Star ordre | Verdict |
|---|---|---|---|---|---|
| 01 | **AutoGPT** | [01_autogpt.md](01_autogpt.md) | MIT (classic) + **Polyform Shield** (platform) | ~184k★ | 🟡 référence pour HITL + sandbox + ProviderBuilder. Lire-only. |
| 02 | **Agent Zero** | [02_agent_zero.md](02_agent_zero.md) | MIT | ~~~ | 🟡 sub-agents récursifs + prompts .md à voler. Philosophie code-natif inverse de la nôtre. |
| 03 | **Observer AI** | [03_observer_ai.md](03_observer_ai.md) | MIT | ~~~ | 🟢 loop + change detection + DSL `$VARIABLE` à voler. Marketplace SQLite à éviter. |
| 04 | **OpenClaw** | [04_openclaw.md](04_openclaw.md) | (à confirmer) | sponsors lourds | 🟢 personas .md + manifest plugin unifié + doctor CLI à voler. Single-user. |
| 05 | **AgenticSeek** | [05_agentic_seek.md](05_agentic_seek.md) | **GPL-3.0** ⚠️ | ~~~ | 🟡 update_plan + protocole browser à ré-implémenter. **Jamais vendoriser**. |
| 06 | **Local Operator** | [06_local_operator.md](06_local_operator.md) | MIT | ~~~ | 🟢 delegate + scheduler tools + auditor 2-pass à voler. Anti-patterns sécu massifs (exec, pkl, CORS). |

---

## 🎬 Prochain pas suggéré

Je propose de transformer la **Roadmap consolidée** ci-dessus en **issues GitHub** ou **migrations versionnées** dans `tools/migrations/` selon ce qui touche DB ou code :

- **P0 #1 (sandbox)** = nouveau service → branche `claude/sandbox` + compose `services/sandbox/docker-compose.yml`
- **P0 #2-3 (HITL+auditor)** = refacto `lib/approval-gate.ts` + nouvelle table `pending_human_review` → `tools/migrations/00XX_hitl_generic.py`
- **P0 #4 (delegate)** = ajout tool dans `services/app/src/app/api/agents-tools/delegate_to_specialist/route.ts`
- **P0 #5 (replan)** = enrichir prompt système Concierge dans Dify (passer par `tools/migrations/`)
- **P1 #6-7** = nouveaux services `services/scheduler/` et `services/watchers/`

Dis quand tu veux que je découpe en tickets/migrations exécutables.
