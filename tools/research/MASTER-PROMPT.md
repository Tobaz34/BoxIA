# 🤖 Master Prompt — BoxIA v2 "OSS-inspired" Implementation

> Prompt à donner tel quel à un agent Claude Code (nouvelle session, sans contexte préalable) pour exécuter la roadmap consolidée issue de l'analyse de 6 projets agents IA OSS.

---

## ⬇️ COPIE LE PROMPT CI-DESSOUS

```text
Tu vas exécuter la roadmap consolidée du projet BoxIA en t'inspirant des patterns identifiés dans 6 projets OSS analysés (AutoGPT, Agent Zero, Observer AI, OpenClaw, AgenticSeek, Local Operator).

## ⚠️ OBLIGATOIRE EN PREMIER (avant TOUTE action)

Lis ces fichiers dans cet ordre. Ce sont tes sources de vérité.

1. `D:\IA_TPE_PME_POWER\CLAUDE.md` — règles impératives projet (3 règles d'or sur xefia / migrations / lock multi-sessions)
2. `C:\Users\andre\.claude\projects\D--IA-TPE-PME-POWER\memory\MEMORY.md` — index mémoire
3. `C:\Users\andre\.claude\projects\D--IA-TPE-PME-POWER\memory\current_state_2026-05-02.md` — état courant projet
4. `C:\Users\andre\.claude\projects\D--IA-TPE-PME-POWER\memory\deployment_workflow.md` — workflow déploiement
5. `D:\IA_TPE_PME_POWER\tools\research\00_SYNTHESE.md` — la roadmap à exécuter (table P0/P1/P2/P3)
6. `D:\IA_TPE_PME_POWER\tools\research\README.md` — index des rapports détaillés

Pour chaque action de la roadmap, lis aussi le rapport détaillé du projet source cité
(ex: action #1 cite AutoGPT → ouvre `tools/research/01_autogpt.md` et trouve la section
"À voler tel quel" / "À adapter" / "Top-3 préconisations" pour l'extrait pertinent).
Le code source des projets OSS est cloné dans `D:\IA_TPE_PME_POWER\.research-cache\<slug>\`
(autogpt, agent-zero, observer-ai, openclaw, agentic-seek, local-operator).

## 🎯 MISSION

Implémenter la roadmap dans l'ordre P0 → P1 → P2 → P3.

### Liste des actions (résumé — détails complets dans 00_SYNTHESE.md)

**P0 (différenciateurs marché, à planifier urgent)**
1. `aibox-sandbox` (bwrap/e2b self-host) + tool `bash_exec` Concierge sous approval-gate — source AutoGPT
2. HITL générique : table `pending_human_review` + flag `is_sensitive_action` sur tous tools mutatifs — source AutoGPT
3. Auditor LLM 2-pass anti-prompt-injection (qwen3 SafetyCheck) — source LocalOp
4. Tool `delegate_to_specialist(slug, prompt)` côté Concierge (MAX_DEPTH=2) — source LocalOp + Agent Zero
5. Replan dynamique : `update_plan()` sur tool-fail + pre-routing complexity HIGH/LOW — source AgenticSeek

**P1 (très impactant)**
6. Scheduler natif côté LLM : 3 tools `schedule_task` / `stop_schedule` / `list_schedules` + APScheduler — source LocalOp
7. Loop passive + change detection (sensors `$EMAIL_INBOX_NEW`, `$ODOO_INVOICES_DUE`, etc.) — source Observer
8. Manifest unifié `boxia.plugin.json` + `aibox doctor` CLI (unifie les 4 marketplaces) — source OpenClaw
9. PII sanitizer marketplace pré-publish (`code_sanitizer.ts`) — source Observer
10. Personas user-éditables fichiers `.md` + UI 4 onglets `/agents/[slug]/configure` — source OpenClaw + Agent Zero

**P2 (qualité)**
11. `<thinking>` stripper robuste avec depth counter — source AutoGPT
12. BM25 reranking sur RAG Qdrant — source AutoGPT
13. StreamingSecretsFilter inbound + outbound SSE — source Agent Zero
14. ProviderBuilder fluent TS pour scaler connecteurs FR — source AutoGPT
15. Memory compression long-context (>30 messages) — source AgenticSeek
16. Onboarding XP/milestones — source AutoGPT

**P3 (à surveiller, ne pas implémenter sans validation user explicite)**
17–21. Browser agent, Knowledge graph LT (Graphiti/neo4j), WebPush, Crédits/Stripe, Builder visuel.

## 📐 RÈGLES DE TRAVAIL

### Cardinales (issues du CLAUDE.md, NON-NÉGOCIABLES)

1. **Serveur xefia read-only sauf via `tools/deploy-to-xefia.sh`** — interdit `ssh ... docker compose` direct, interdit `scp/cp/mv/vim/tee` sur `/srv/ai-stack/`. Lecture seule (`docker ps`, `docker logs`, `psql -c "SELECT..."`) OK.
2. **Toute mutation DB live = migration versionnée** dans `tools/migrations/<NNNN>_<desc>.py` avec `is_applied()`, `run()`, `DESCRIPTION`. Idempotente. Voir `tools/migrations/README.md` et l'exemple `0001_dify_max_tokens_8192.py`.
3. **Une seule session déploie xefia à la fois** (lock `tools/deploy-to-xefia.sh --status`).

### Workflow par action

Pour CHAQUE action de la roadmap, dans cet ordre strict :

1. **Plan avec TodoWrite** : décompose l'action en 3-8 sous-tâches concrètes.
2. **Lis le code OSS source** dans `.research-cache/<slug>/` au chemin précis cité dans le rapport détaillé. Comprends le pattern. Ne copie JAMAIS le code (raisons de licence — `Polyform Shield` AutoGPT, `GPL-3.0` AgenticSeek). Ré-implémente depuis l'idée en TS/Python adapté à notre stack.
3. **Vérifie l'existant chez nous** : `Glob` / `Grep` dans `services/app/src/`, `services/`, `tools/`. Ne crée pas de doublon.
4. **Implémente** :
   - Code Next.js → `services/app/src/` (suivre conventions existantes : route handlers `app/api/.../route.ts`, libs dans `lib/`, composants dans `components/`)
   - Nouveau service Docker → `services/<nom>/docker-compose.yml` + `Dockerfile` + README
   - Mutation DB / Dify / n8n → `tools/migrations/<NNNN>_<desc>.py` idempotente
   - Hook → `tools/hooks/`
5. **Tests** : si la fonctionnalité touche du code TS, vérifie `npm run typecheck` et `npm run build` dans `services/app/`. Si touche Python, exécute les tests présents.
6. **Branche dédiée** : `claude/v2-P{N}-{numéro}-{slug-court}` (ex `claude/v2-P0-04-delegate-tool`). Ne push PAS automatiquement, attends mon ordre.
7. **Commit** au format `feat(P{N}-{numéro}): <résumé court>` avec un body listant : motivation, source d'inspiration, fichiers modifiés.
8. **Met à jour `tools/research/00_SYNTHESE.md`** : ajoute une colonne `Status` à la table de la section "🎯 Roadmap consolidée" avec `✅ done <date> <commit-sha>`, `🚧 in-progress`, ou `⏸️ blocked: <raison>`.
9. **Mémoire** : si tu apprends un fait durable (architecture cible décidée, contrainte non-évidente, piège évité), écris une mémoire dans `C:\Users\andre\.claude\projects\D--IA-TPE-PME-POWER\memory\`. NE STOCKE PAS l'avancement courant — c'est volatile, ça va dans la todo / la PR / les commits.
10. **STOP et reporte au user** avant de passer à l'action suivante. Format de rapport :
    - 1 paragraphe résumant ce qui a été fait
    - Liste des fichiers modifiés
    - SHA du commit créé
    - Tests qui passent / fail
    - Question explicite : "OK pour passer à l'action #N+1 ?" ou "Veux-tu reviewer cette PR avant ?"

### Stop conditions (TOUJOURS s'arrêter et demander)

- Après CHAQUE action P0 ou P1 complétée → STOP, attends "continue" / "next" / "ok" du user.
- Si une migration `is_applied()` retourne `True` de manière inattendue → STOP, demande au user.
- Si `npm run build` ou les tests Python échouent et que tu ne peux pas trouver la cause en 3 essais → STOP, expose le problème.
- Si tu découvres une dépendance imprévue (refacto pré-requis, table manquante, modif Dify imprévue) → STOP, propose 2-3 options au user.
- Si l'action requiert un déploiement xefia → STOP, ne lance JAMAIS `tools/deploy-to-xefia.sh` toi-même. Ce script peut tourner 5-10 min, créer un tag de backup, faire un reset hard. Demande au user de le lancer.
- Si l'action P2 ou P3 risque de casser une feature existante (ex: refacto `connectors.ts` en builder fluent) → STOP, propose un plan détaillé avant de toucher.

### Ce que tu N'AS PAS LE DROIT de faire

- Pousser sur `main`, créer un PR sur GitHub, ou merger une branche sans demander.
- Modifier `CLAUDE.md` ou `memory/MEMORY.md` sans demander (mémoire détail OK).
- Lancer `tools/deploy-to-xefia.sh` ou un `docker compose up` sur xefia.
- Faire un `git push --force`, `git reset --hard origin/main`, `git checkout .` ou `git rebase -i`.
- Modifier la DB live de Dify / n8n / Authentik / Postgres directement (UPDATE/INSERT/DELETE) — tout passe par migration versionnée.
- Vendoriser du code AGPL/GPL-3.0 (AgenticSeek) ou Polyform Shield (`autogpt_platform/`). Tu peux LIRE et t'inspirer, jamais copier.
- Skipper les hooks pre-commit (`--no-verify`).
- Implémenter au-delà du périmètre d'une action (pas de cleanup général, pas de refacto opportuniste).

## 🧠 Conventions BoxIA à respecter

- **TypeScript strict** sur Next.js (pas de `any`, `noImplicitAny`).
- **Routes API Next.js** : exporter `GET`/`POST`/etc. depuis `app/api/<path>/route.ts`. Utiliser `requireSession()` (à voir dans `lib/auth.ts`) pour l'auth Authentik.
- **Migrations** : `is_applied()` doit query Postgres (Dify ou aibox), retourner `True` si déjà fait, idempotente. Pattern dans `tools/migrations/0001_dify_max_tokens_8192.py`.
- **Docker compose** : un service par dossier `services/<nom>/docker-compose.yml`. Toujours un `network` partagé `aibox-net`. Toujours `restart: unless-stopped`. Volumes nommés `aibox_<service>_data`.
- **i18n** : tout texte UI passe par `services/app/src/lib/i18n/{fr,en}.ts`. Pas de chaîne hardcodée FR/EN dans les composants.
- **Audit log** : toute action mutative passe par `lib/audit.ts` (`auditLog({ action, user, payload })`).
- **Commits** : format `<type>(scope): <résumé>`, types `feat|fix|chore|docs|refactor|test|perf`. Body français, signé `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Branche par action** : `claude/v2-P{N}-{NN}-{slug}`.

## 🚀 PREMIÈRE ACTION

Commence par l'action **P0 #1 — `aibox-sandbox`** (la plus structurante).

Pour cette action :
- Source pattern : AutoGPT `backend/copilot/tools/e2b_sandbox.py` + `bash_exec.py` (sous `Polyform Shield` → réimplémente)
- Lis `tools/research/01_autogpt.md` section "À voler tel quel" + section "Top-3 préconisations §1"
- Stack à utiliser : `bubblewrap` (déjà disponible dans la plupart des distros Linux serveur — pas e2b cloud, on est local)
- Architecture cible :
  - Nouveau service `services/sandbox/` avec compose qui lance un container minimal `python:3.12-slim` + `bubblewrap` + entrypoint HTTP (Flask ou FastAPI) qui reçoit `{lang: "bash"|"python", code: str, timeout: int}` et renvoie `{stdout, stderr, exit_code, duration_ms}`. Filesystem r/o sauf `/tmp/work` writable. Network off par défaut.
  - Nouveau tool Concierge `services/app/src/app/api/agents-tools/bash_exec/route.ts` qui POST sur le sandbox + flag `is_sensitive_action: true`.
  - Approval-gate : reuser `lib/approval-gate.ts` (hook le check avant l'appel HTTP). Si l'action n'est pas pré-approuvée, retourner un payload `{pending: true, approval_id: ...}` que le frontend transforme en banner orange.
  - Migration `tools/migrations/00XX_register_bash_exec_tool.py` qui inscrit le Custom Tool dans Dify et le lie au Concierge agent.

Plan, demande validation du plan avant de coder, puis exécute.

Si tu as besoin d'éclaircissement sur le périmètre : demande au user en début de session, ne devine pas.
```

---

## 🧭 Conseils d'usage de ce prompt

- **Donne-le à une session Claude Code fresh**, idéalement Opus avec 1M de context (les rapports + la roadmap font ~80 KB cumulés).
- **Mode permission** : commence en `plan` mode pour la 1re action. Quand tu as validé le plan, passe en `acceptEdits` ou `dangerouslySkipPermissions` selon ton appétit.
- **Une session = quelques actions max**. N'attends pas qu'un seul agent fasse les 21 actions — il va saturer son contexte. Idéalement 2-3 actions P0 par session, puis nouvelle session avec ce même prompt.
- **Worktree** : pour chaque action P0, fais `git worktree add .claude/worktrees/v2-p0-NN <branche>` et lance l'agent dans le worktree → isole les changements et te permet de paralléliser plusieurs P0 (1 worktree par action).
- **Avant de commencer** : vérifie que `.research-cache/` est encore là (il est gitignored, donc pas synchro auto si tu changes de machine). Sinon le prompt te dit comment re-cloner.

## 🔁 Variations possibles

- **Mode "P0 only"** : remplace la phrase "Implémenter la roadmap dans l'ordre P0 → P1 → P2 → P3" par "Implémenter UNIQUEMENT les 5 actions P0. Ne touche pas P1+. Stop après P0 complète."
- **Mode "single action"** : remplace par "Implémenter UNIQUEMENT l'action P{N} #{NN}. Stop dès que c'est fait."
- **Mode "audit"** : remplace par "Pour chaque action P0/P1, audite l'existant, écris un fichier `tools/research/audit_P{N}_{NN}.md` qui décrit ce qui existe déjà chez nous, ce qu'il manque, le plan d'attaque détaillé. N'IMPLÉMENTE RIEN. Présente les audits au user pour priorisation."

Le **mode "audit"** est ce que je recommande pour démarrer si tu n'es pas encore sûr du périmètre exact action par action — il te donne une visibilité fine avant de te lancer dans 1-2 semaines de dev.
