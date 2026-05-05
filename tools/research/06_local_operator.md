# Local Operator — Analyse pour BoxIA

## Fiche d'identité

| Champ | Valeur |
|---|---|
| Nom | Local Operator |
| Repo | `damianvtran/local-operator` (clone : `D:\IA_TPE_PME_POWER\.research-cache\local-operator\`) |
| Licence | MIT |
| Stack backend | Python 3.12, FastAPI + uvicorn, LangChain (`langchain_openai`/`_anthropic`/`_google_genai`/`_ollama`), APScheduler, Pydantic |
| Stack frontend | UI Electron séparée (`damianvtran/local-operator-ui`, **non clonée**) |
| Runtime | CLI + serveur HTTP local (`local-operator serve` → `http://localhost:8080`) + WebSockets |
| Cible utilisateur | Single-user / desktop (un dossier `~/.local-operator/`, un dossier `~/local-operator-home/` par OS user) |
| Tagline | "Personal AI Assistants that Turn Ideas into Action — real-time code execution on your device through natural conversation" |
| Modèle business | Open source + service cloud optionnel **Radient** (auto-routing modèle, agent hub partagé, signature email, transcription/TTS) |

## Architecture

Un seul process Python orchestre tout. Pas de Docker compose multi-container, pas d'auth, pas de RBAC, pas de DB relationnelle — tout est sur le filesystem de l'utilisateur.

```
~/.local-operator/
├── config.yml              (settings : conversation_length, hosting défaut, model_name…)
├── credentials.yml         (chiffré ?  → en clair, voir credentials.py L1-171)
└── agents/<agent_id>/
    ├── agent.yml           (AgentData : name, hosting, model, security_prompt, temperature…)
    ├── conversation.jsonl  (ConversationRecord par ligne)
    ├── execution_history.jsonl
    ├── learnings.jsonl
    ├── schedules.jsonl     (Schedule par ligne)
    └── context.pkl         (variables Python pickled — non importé pour raison de sécurité, agents.py L1434)
```

### Modules-clé (`local_operator/`)

| Fichier | LOC | Rôle |
|---|---|---|
| `executor.py` | 3 238 | **Cœur du système.** Boucle CODE/WRITE/EDIT/READ/DELEGATE, exec wrapping `async def`, capture stdout/stderr/logging, retry on error, auto-correction par LLM, file edit avec `replacements`, summarization conversation, token metrics avec `tiktoken` |
| `prompts.py` | 2 584 | `BaseSystemPrompt` (L358), `SafetyCheckSystemPrompt` (L1207) — prompt safety isolé du prompt principal |
| `agents.py` | 1 838 | `AgentRegistry` : CRUD agents, import/export ZIP, push/pull Radient Hub, migrate legacy formats, refresh interval (le serveur lit le disque toutes les 3s pour voir les modifs des sous-process planifiés) |
| `operator.py` | 1 266 | Wrapper user-facing : `handle_user_input()`, classification intent (RequestType), planning, delegate callback |
| `tools/general.py` | 2 200+ | Tools natifs : `search_web`, `get_page_html_content` (Playwright), `generate_image` (FAL/FLUX.1), `run_browser_task` (browser-use + adapter LangChain), `schedule_task`, `stop_schedule`, `list_schedules`, `send_email_to_user`, `start/stop_recording` (screen recording !), Google Workspace (Gmail/Drive/Calendar) via `tools/google.py` |
| `scheduler_service.py` | 924 | APScheduler + cron + multiprocessing.Queue. Chaque tâche planifiée tourne dans un **sous-process séparé** (`_execute_scheduled_task_logic`), communique avec le main via Queue (`("status_update", job_id, status, payload)`) |
| `model/registry.py` | 50 405 b | Registre statique de tous les modèles connus avec pricing/context window/recommended flag par provider |
| `model/configure.py` | 27 ko | `configure_model()` switch sur 7 hostings : openai / anthropic / google / deepseek / ollama / openrouter / radient / mistral / kimi / mock / noop |
| `clients/` | — | radient.py, openrouter.py, ollama.py, fal.py, serpapi.py, tavily.py, google_client.py |
| `server/routes/` | — | 12 routers : agents, chat, config, credentials, health, jobs, models, schedules, speech, transcription, websockets, static |

### Flow d'une requête (CLI ou serveur)

1. **Classification** (`RequestClassificationSystemPrompt`) : type, planning_required, relative_effort, subject_change → décide si on plan ou si on exécute direct
2. **Plan** (si requis) : produit `current_plan` + `instruction_details` persistés
3. **Action loop** :
   - LLM produit `ResponseJsonSchema` `{response, code, action: CODE|WRITE|EDIT|READ|DELEGATE, file_path, content, replacements, mentioned_files, agent, message, learnings, thinking}`
   - **Safety check via 2e LLM call** (`SafetyCheckSystemPrompt` + le code à exécuter) → `[SAFE] | [UNSAFE] | [OVERRIDE]`. Si UNSAFE et pas de prompt_user (mode serveur), le system msg explique au LLM principal qu'il doit demander l'autorisation au user dans la conversation
   - Si SAFE/OVERRIDE → `_run_code()` : `compile()` puis `exec()` dans `self.context` (dict Python persistant entre messages — c'est le state du REPL). Les `async def`/`await` sont wrappés dans une coroutine qui réinjecte ses locals dans `context`
   - Capture stdout/stderr/logging via `io.StringIO` swap, streame au client en chunks (TTY-style)
4. **Reflection** : LLM analyse stdout/stderr/files créés
5. **Response** : message final user-facing
6. **Summarization** : si `conversation_length > 100`, summarize les vieux messages au-delà de `detail_length=35`

### Modes d'exécution

- `local-operator` — interactive REPL (CLI)
- `local-operator exec "<task>"` — single-shot script
- `local-operator serve` — FastAPI HTTP + WebSocket
- `--agent <name>` — charge un agent persisté (conversation, learnings, system prompt custom)
- `--hosting radient` — auto-pick model par étape (cost-optimized) via Radient cloud

## Features remarquables

### 1. Code execution sandboxé "best-effort" en process Python
Pas de vrai sandbox (pas de gVisor, Firecracker, Docker-in-Docker). C'est `exec()` dans le même process, mais :
- **Safety check 2-LLM** : un LLM "auditeur" indépendant analyse le code avant exécution avec son propre system prompt anti-injection (`SafetyCheckSystemPrompt`, prompts.py L1207-1320). Patterns détectés : `os.remove('system.dll')`, `requests.post('http://...api_key...')`, `git push -f origin main`. Réponse `[SAFE]/[UNSAFE]/[OVERRIDE]`.
- **`security_prompt` par agent** (AgentData L42) : le user peut whitelister des patterns par agent ("cet agent peut faire des git operations")
- **Confirmation user dans le chat** quand `can_prompt_user=False` (mode serveur) : l'auditeur écrit l'analyse, le LLM principal la résume au user en langage naturel et attend OK
- **stdin coupé sur `/dev/null`** pendant exec (executor.py L1556)
- **Wrapping async** : detect `async def`/`await` et exec dans une coroutine wrapper (L1559-1597)
- **Sync libs blacklist** : matplotlib/tkinter/PIL exec en main thread, le reste en `asyncio.to_thread()`

### 2. Délégation entre agents (`ActionType.DELEGATE`)
Un agent peut appeler un autre agent par nom avec un message (executor.py L2182-2250). Le résultat revient comme contexte. C'est l'équivalent multi-agent simple, sans framework lourd type CrewAI. Pas de team manager, pas de role assignment automatique — l'agent décide qui appeler.

### 3. Scheduling first-class avec multiprocessing
- `Schedule` Pydantic model avec UUID, agent_id, prompt, interval, unit (`MINUTES/HOURS/DAYS`), start/end_time_utc, last_run_at, is_active, one_time
- APScheduler avec `CronTrigger`/`DateTrigger`, `misfire_grace_time` calculé en fonction de l'unit
- **Chaque exécution scheduled tourne dans un sous-process séparé** (`multiprocessing.Process`), reconstruit ses managers from disk, communique via `multiprocessing.Queue` au main scheduler
- Tools `schedule_task` / `stop_schedule` / `list_schedules` exposés au LLM → l'agent peut auto-planifier ses propres relances ("rappelle-moi tous les lundis à 9h de…")
- Job spécial `_execute_radient_token_refresh_task` toutes les 15 min (refresh Google access token via Radient bridge)

### 4. Multi-LLM router
`configure_model()` (model/configure.py L276) : un seul switch supporte 11 hostings, dont :
- **Radient** : auto-routing serveur cloud → model = `"auto"` (le serveur Radient choisit GPT-4 vs Claude vs Llama selon la difficulté de l'étape pour optimiser cost). Headers `HTTP-Referer: local-operator.com` + `X-Title: Local Operator` pour leur backoffice.
- Anthropic + Gemini natifs (pas que via OpenAI compat)
- ChatMock / ChatNoop pour tests sans appel réseau

### 5. Browser-use intégration
`run_browser_task()` (tools/general.py L1388) : LLM contrôle Playwright via librairie `browser_use`. Adapter `_BrowserUseLangChainAdapter` (L1101) bridge entre les ChatModel LangChain et l'API native browser-use.
- **Auto-discovery du Chromium installé** (`_get_browser_path`, scan ports CDP `_scan_for_browser_connection_urls`) — peut s'attacher à une instance Chrome déjà ouverte
- Headless ou headful, keep-alive

### 6. Radient Agent Hub
Push / pull d'agents en ZIP vers un hub public (similaire spirituel HuggingFace pour agents). `local-operator agents push --name X` → hub. `pull --id <radient_id>` → import sans auth.
**Sécurité** : à l'import, `context.pkl` est skippé (agents.py L1434) — pas d'objets Python sérialisés non-vérifiés. Seuls `agent.yml`, `conversation.jsonl`, `execution_history.jsonl`, `learnings.jsonl` sont importés.

### 7. Persistance fine du context Python
Le dict `self.context` du `LocalCodeExecutor` est pickled à la fin de chaque session (`save_agent_context`, agents.py L954). Au reload, on le dépickle (`load_agent_context` L1046). Les fonctions builtins et objets non-picklables sont filtrés via `convert_unpicklable()`. Permet à un agent "data analyst" de retrouver son DataFrame `df` la session suivante.

### 8. Learnings list
À chaque step, le LLM peut écrire un `learnings` text dans la réponse JSON. Liste plafonnée par `max_learnings_history=50`, persistée dans `learnings.jsonl`, réinjectée dans le prompt système des sessions suivantes. C'est la mémoire long-terme rudimentaire (similaire principe à mem0 mais en plus simple, sans embeddings).

### 9. Tools "écosystème prêt à brancher"
Liste des tools natifs (tools/general.py + google.py) :
- `search_web` (SERP API ou Tavily)
- `get_page_html_content` / `get_page_text_content` (Playwright)
- `generate_image` / `generate_altered_image` (FLUX.1 via FAL ou Radient)
- `run_browser_task`
- `schedule_task` / `stop_schedule` / `list_schedules`
- `send_email_to_user` (via Radient)
- `create_audio_transcription` / `create_speech` (TTS/STT via Radient)
- `start_recording` / `stop_recording` (screen recording !)
- Gmail (`get_gmail_message`, `list_gmail_messages`, `send_gmail_message`, drafts CRUD)
- Calendar (`list_calendar_events`, `create_calendar_event`, update, delete)
- Drive (`list_drive_files`, `download_drive_file`, upload, update content/metadata)
- `get_credential` / `list_credentials`

## Comparatif avec BoxIA

| Dimension | Local Operator | BoxIA | Verdict |
|---|---|---|---|
| **Cible utilisateur** | Single-user desktop (1 process, 1 dossier `~/.local-operator/`) | Multi-user serveur partagé (Authentik OIDC, RBAC, audit log, RGPD, PII scrub) | Architectures incompatibles. Local Operator = "ton assistant", BoxIA = "le serveur de la PME" |
| **Code execution** | `exec()` dans process Python avec safety-LLM-auditor + override prompts par agent | **Aucune** exécution arbitraire LLM. Concierge a 10 tools HTTP whitelist + approval gate banner orange UI sur tools mutatifs | BoxIA est plus safe par design (whitelist) mais perd la capacité de "résous mon problème inconnu". **Gap réel** pour TPE/PME power-users qui veulent un Python REPL piloté |
| **Multi-agent (équipe)** | `DELEGATE` action native — un agent appelle un autre par nom dans la conversation | 6 agents Dify isolés (général, vision, comptable, RH, juridique, marketing). Pas de délégation runtime — l'utilisateur switch manuellement | BoxIA n'a pas l'équivalent. Pourrait s'inspirer pour un "agent général" qui route vers le spécialisé via tool call |
| **Multi-LLM router** | 11 hostings (openai/anthropic/google/deepseek/ollama/openrouter/radient/mistral/…) avec model par agent | Cloud Providers BYOK déjà fait (OpenAI/Anthropic/Mistral en sus du local Ollama qwen3) — voir sprint 2026-05-01 standard | Parité atteinte. BoxIA en plus a le PII scrub avant cloud (7 patterns FR) que Local Operator n'a pas |
| **Auto-routing modèle** | Radient `--hosting radient --model auto` choisit le modèle par étape | Manuel — l'utilisateur ou l'agent choisit le modèle | **Idée à voler** : router heuristique léger côté concierge ("question simple → qwen3:14b local, code complexe → Claude API si BYOK") |
| **Scheduling** | APScheduler + sous-process + cron, agent peut s'auto-planifier via `schedule_task` tool. UI dédiée dans Local Operator UI | Workflows n8n peuvent être schedulés (cron node), mais **les agents Dify eux-mêmes ne sont pas schedulables** depuis BoxIA | **Gap** majeur. BoxIA pourrait ajouter un tool `schedule_agent_run` au Concierge avec une route Next.js + cron node-cron ou APScheduler-like |
| **Persistance context Python** | `context.pkl` par agent (pickled REPL state, DataFrames préservés cross-session) | RAG Qdrant + mem0 (mémoire conversationnelle) — pas de "DataFrame qui survit" | Cas d'usage différent (BoxIA n'expose pas Python). Skip. |
| **Mémoire / learnings** | `learnings.jsonl` plafonné à 50, réinjecté dans system prompt | mem0 (graph memory) + RAG documents | BoxIA est plus avancé. Pas d'inspiration nécessaire. |
| **Observabilité** | Logging Python standard, status_queue WebSocket pour streamer au frontend | **Langfuse v2 self-hosted** wired dans `/api/chat` avec tee stream | BoxIA bien plus mature ici |
| **Agent hub / marketplace** | Radient Hub (ZIP push/pull, public, sans auth pour pull) | Marketplaces Dify-FR (6 templates métier), n8n (39 workflows), MCP (15 servers), tous internes au repo | Approches différentes. Radient Hub = collaboratif global, BoxIA = catalogue curé pour PME FR |
| **Browser automation** | `run_browser_task` (browser-use + Playwright auto-discovery du Chrome) | Pas d'équivalent direct (Concierge n'a pas browser tool) | **Idée à voler** pour un connecteur "navigateur" (cas : "scrape le portail fournisseur Pennylane"). Risque sécu serveur partagé à étudier |
| **TTS / STT / image gen** | Radient bridge (FLUX.1, Whisper, Piper-like) + FAL direct | Piper TTS commit `c06a339` infra prête (sprint v1.1) — STT/image pas faits | Parité partielle. BoxIA peut adopter le même pattern factory tool |
| **Approval gate (action mutative)** | Safety-LLM auditor + user confirmation in chat (mode serveur) — **aucune UI dédiée**, tout dans la conversation | `/api/concierge/decide` + banner orange UI (tools mutatifs install_workflow / install_agent_fr passent par approval) | BoxIA UX supérieure (UI dédiée vs message en chat). À garder. |
| **Sandboxing real** | `exec()` dans process — **partage tout l'env Python** (memory, fs, network) | Tools HTTP whitelist sans exécution arbitraire | BoxIA plus safe pour serveur multi-tenant. Local Operator OK pour desktop solo. |
| **Single-process simplicity** | Tout dans 1 binaire `local-operator` | 33 containers Docker | Local Operator est install-en-1-commande (`pip install local-operator`), BoxIA est install-clé-en-main mais lourd. Parité côté UX user final. |
| **Cross-platform desktop** | UI Electron (repo séparé `local-operator-ui`) Windows/Mac/Linux | Web app Next.js servie par container `aibox-app` | Cibles différentes. |

## À voler tel quel

1. **Tool `schedule_task` exposé au LLM** — l'agent peut s'auto-planifier ("rappelle-moi de check les emails non-lus tous les matins à 9h"). Implémentation : créer route `/api/concierge/tools/schedule_task` côté `services/app/src/app/api/concierge/`, persister dans table Postgres `agent_schedules`, runner cron via container dédié ou node-cron in-process. Le LLM voit la tool dans son OpenAPI Custom Tool Dify. **Branchable directement sur le Concierge existant** (10 tools déjà). Voir Schedule pydantic model dans `local_operator/types.py` L385-438 pour le shape.

2. **Auditor LLM 2-pass pour les actions mutatives sensibles** — au lieu d'une simple whitelist (BoxIA actuel), un 2e LLM pourrait analyser le payload du tool call avant approval gate. Exemple : avant `install_workflow` du Concierge, un mini-LLM (qwen3 1B local en 200ms) vérifie que le workflow ne contient pas une node "Execute Command" suspecte. Voir `executor.py:check_response_safety()` et `prompts.py:SafetyCheckSystemPrompt` (L1207). Combine avec le banner orange existant.

3. **Pattern Adapter LangChain ↔ tool natif** — `_BrowserUseLangChainAdapter` (tools/general.py L1101) montre comment wrapper un client LLM existant (BoxIA = Dify completion API) pour qu'il soit utilisable par une lib qui attend l'API LangChain. Utile si on veut intégrer browser-use, autogen, ou n'importe quelle lib agent qui suppose `model.ainvoke(messages)`.

## À adapter

1. **DELEGATE entre agents** — Local Operator a un appel direct `delegate_to_agent(name, message)` qui retourne un `CodeExecutionResult`. Pour BoxIA, équivalent serait : ajouter au Concierge un tool `delegate_to_specialist(agent_slug, prompt)` qui POST sur le Dify completion endpoint de l'agent spécialisé (comptable/RH/juridique) et retourne sa réponse. Le LLM général voit alors son équipe comme des "sub-tools". **Adaptation** : pas besoin de la conversation Python — juste un orchestrateur stateless via Dify API. Très peu de code (~80 lignes), gros gain UX.

2. **Auto-routing modèle par étape** — Radient le fait côté serveur cloud propriétaire. Version locale BoxIA : heuristique côté Concierge `routeModel(taskClassification)` → `qwen3:14b` (local) si simple/FR/long-context, `claude-sonnet-4` (BYOK) si raisonnement complexe, `qwen2.5vl:7b` si image. Économise les credits Cloud Providers. Voir `model/configure.py:configure_model()` pour le shape ModelConfiguration.

3. **Learnings list légère** — alternative simple à mem0 si on veut un MVP. Champ `learnings: string[]` ajouté à chaque message agent, plafonné, injecté en début de prompt. Pas d'embeddings, pas de Qdrant. Pour BoxIA, mem0 fait déjà mieux mais peut servir de fallback offline si mem0 down.

4. **Pattern sous-process pour scheduled tasks** — Local Operator isole chaque tâche planifiée dans un `multiprocessing.Process` qui crash-isole le main scheduler (scheduler_service.py L40-201). BoxIA équivalent serait : workflow n8n trigger cron qui POST sur `/api/concierge/run_scheduled_prompt`, et l'API Next.js spawn un worker isolé (Bull queue ?) pour pas bloquer. Existe déjà partiellement via n8n.

## À surveiller

1. **Radient cloud auto-router** — concept à benchmarker. Si en 6 mois ils prouvent que routing par étape réduit cost de 40% sans dégrader la qualité, c'est un argument commercial fort à intégrer dans la roadmap "BoxIA Premium" (router intelligent local-first / cloud-fallback).

2. **Local Operator UI Electron** — référence intéressante pour l'UX desktop d'un agent local. Si BoxIA sort un mode "édition gratuite mono-poste" pour les solos/freelances, le pattern Electron + serveur local Python est une option vs notre Next.js + Docker actuel (lourd pour 1 user).

3. **Radient Agent Hub** — si la marketplace open prend, pourrait inspirer BoxIA Marketplace publique (mutualisation entre PME). Aujourd'hui nos marketplaces sont internes au repo. Risque : RGPD/IP des prompts métiers FR.

4. **`browser-use` lib** — la dépendance Python qu'ils utilisent. Évolue vite (LLM-driven Playwright). À surveiller pour un futur connecteur "browser scraping" BoxIA, sachant qu'un browser headless sur serveur partagé pose des questions sécu sérieuses (XSS, exfiltration, ressources GPU).

## Pièges identifiés

1. **`exec()` dans le même process Python = aucun isolement réel.** Local Operator se repose sur le LLM auditor pour bloquer les `os.remove('/etc/passwd')`, mais un prompt injection peut tromper l'auditor. **Pour BoxIA serveur partagé multi-user, c'est inacceptable.** On garde notre approche whitelist + approval gate. Si on veut un jour un Python REPL utilisateur, ça doit tourner dans un container `aibox-sandbox-<user>` Docker éphémère avec network=none, pas dans le container `aibox-app`.

2. **Credentials en clair dans `~/.local-operator/credentials.yml`.** Voir `credentials.py` 171 LOC — pas de chiffrement at-rest visible dans le repo. Ils comptent sur le fs perms du home directory. **Inacceptable pour BoxIA** où on chiffre déjà les PAT GitHub avec master key (sprint self-update 2026-05-03).

3. **`context.pkl` pickled = code-execution-on-load.** Skippé à l'import d'agent depuis Hub (good), mais utilisé en local. Pour un single-user desktop OK, pour BoxIA où des agents sont partagés inter-users dans le même container c'est une RCE déguisée. À ne **jamais** copier.

4. **Pas d'auth.** Le serveur `local-operator serve` n'a aucun bearer/cookie. CORS `allow_origins=["*"]` (server/app.py L125). C'est volontaire (single-user localhost), mais à ne pas reproduire si on transpose un module.

5. **Refresh interval 3s du AgentRegistry sur disque** (server/app.py L69, agents.py L184) — pour synchroniser le main process avec les sous-process scheduled qui modifient les agent.yml. Solution simpliste, OK pour single-user, ferait écrouler un BoxIA multi-user (lock contention sur agents.jsonl). Si on adopte le pattern "agent peut modifier son state", utiliser Postgres avec listen/notify, pas du polling fs.

6. **Auto-correction infinie.** `executor.py:_get_corrected_code()` (L1764) relance le LLM avec le traceback et lui demande un fix. Si la lib manque, il pourrait `pip install` n'importe quoi. Local Operator s'en remet au safety auditor, mais une boucle prompt-injection-vers-pip-install-malware-hijacké est plausible. À borner strictement (max_retries=1 chez eux, mais l'attaque peut se faire en 1 seul retry).

## Top-3 préconisations BoxIA

### 1. Ajouter un tool `schedule_agent_task` au Concierge (gros impact, faible effort)
**Pourquoi** : c'est l'écart UX le plus visible avec Local Operator/Cursor/Cline. Aujourd'hui le client BoxIA ne peut pas dire "envoie-moi un récap des impayés Pennylane chaque lundi 9h". Il doit cliquer dans n8n marketplace, importer le workflow, le configurer, l'activer. Friction énorme.

**Comment** :
- Schema Pydantic copié de `local_operator/types.py:Schedule` (L393-438) → table Postgres `agent_schedules`
- Tool OpenAPI `schedule_agent_task(agent_slug, prompt, cron_expression, one_time?)` exposé dans le Concierge (à côté des 10 existants)
- Runner : container léger `aibox-scheduler` avec node-cron OU réutiliser n8n (créer un workflow caché par schedule, qui POST sur `/api/agents/<slug>/run` au trigger)
- Approval gate : passer par le banner orange UI (sprint v1.1 commit `ffce366`) pour les premières exécutions, puis auto-approve les schedules récurrents validés
- UI : section dédiée `/scheduled-tasks` dans BoxIA app, similaire à `/connectors` ou `/workflows`

**Effort** : ~2-3 jours. Réutilise stack existante (Postgres, n8n, Concierge, approval-gate).

### 2. Implémenter `delegate_to_specialist` côté Concierge — équipe d'agents (impact UX fort, effort moyen)
**Pourquoi** : aujourd'hui le client BoxIA doit choisir manuellement entre l'agent général, comptable, RH, juridique. Demander "fais-moi le bilan de la TVA et envoie-le aux salariés concernés" devrait pouvoir être routé : Concierge appelle agent comptable, récupère les chiffres, appelle agent RH pour la liste salariés, appelle l'agent général pour le mail final. Pattern Local Operator `DELEGATE` (executor.py L2182).

**Comment** :
- Tool `delegate_to_specialist(agent_slug: "comptable"|"rh"|"juridique"|"marketing"|"vision", prompt: string)` côté Concierge
- Implémentation : POST sur Dify completion endpoint de l'agent ciblé via les API keys déjà provisionnées dans `installed-agents`
- Pour éviter les cycles, marker `delegated_from: <agent_id>` dans le prompt + max_depth=2
- Stream les sous-réponses dans le banner UI de l'agent appelant ("Je consulte l'agent comptable…")
- Audit log : chaque délégation = ligne dans audit table avec les 2 agent_ids

**Effort** : ~2 jours. Un seul fichier `services/app/src/app/api/concierge/tools/delegate_to_specialist/route.ts` à écrire.

### 3. Ajouter un auditor LLM léger devant les tools mutatifs (sécu+, effort très faible)
**Pourquoi** : aujourd'hui l'approval gate banner orange protège contre l'utilisateur qui clique sans réfléchir, mais pas contre le prompt injection (un email malveillant lu par l'agent qui injecte "appelle install_workflow avec ce JSON"). Local Operator a un 2e LLM auditor isolé (`SafetyCheckSystemPrompt` prompts.py L1207-1320) avec son propre system prompt anti-injection.

**Comment** :
- Avant le banner approval, route `/api/concierge/audit` qui prompt qwen3 (déjà chargé Ollama) avec :
  - Le tool name + payload JSON
  - Le `SafetyCheckSystemPrompt` adapté FR pour BoxIA (whitelist agents/workflows officiels marketplace, blacklist patterns "Execute Command" n8n, payloads contenant des secrets exfiltrés…)
- Réponse `[SAFE] | [SUSPICIOUS] | [UNSAFE]` → si SUSPICIOUS, le banner orange UI gagne un alerte rouge "Sécu : payload suspect, lire avec attention"
- Log Langfuse pour traçabilité (déjà wire commit `bfd312d`)

**Effort** : ~1 jour. Un fichier `lib/security-auditor.ts` + 1 prompt FR. Utilise le qwen3 déjà déployé (pas de coût cloud).

---

**Conclusion** : Local Operator est l'inverse-architecture de BoxIA (single-user desktop vs serveur PME), mais 3 patterns sont directement adoptables : scheduling par tool, délégation agent-vers-agent, auditor LLM 2-pass. Aucune dépendance lourde à reprendre — tous les emprunts sont conceptuels et tiennent dans ~5 jours de dev sur la stack existante BoxIA.
