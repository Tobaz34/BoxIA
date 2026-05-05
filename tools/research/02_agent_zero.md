# Agent Zero — Analyse pour BoxIA

> Rapport rédigé 2026-05-05 par session `eager-buck-3b6e79`. Source : clone shallow `D:\IA_TPE_PME_POWER\.research-cache\agent-zero\` (HEAD `main`, 2026-02-22 reconnaissance dans `AGENTS.md`).

---

## Fiche d'identité

| Champ | Valeur |
|---|---|
| Repo | https://github.com/agent0ai/agent-zero |
| Licence | MIT (`Copyright (c) 2025 Agent Zero, s.r.o`) |
| Mainteneur | société Agent Zero, s.r.o (commercial entity, basée en Tchéquie) |
| Activité | Très active — branches `main`, `ready`, `testing`, `development` (cf. `helpers/self_update.py:18-23`), CI Docker auto sur tags `>= v1.0` |
| Public cible | Devs / power-users qui veulent un agent général-purpose avec accès Linux complet ; pas un produit clé-en-main pour TPE/PME |
| Maturité | Production-grade côté framework (1043 lignes `agent.py`, 25+ extension hooks, plugin system complet, MCP client+server, OAuth pour Codex), mais **mode opératoire = console power-user**, pas SaaS multi-tenant |
| Stack | Python 3.12 (Flask + LiteLLM + LangChain) + Alpine.js (UI) + Playwright (browser tool) + FAISS (memory) + Whisper/Kokoro (STT/TTS) + Docker (deux runtimes Python isolés `/opt/venv-a0` framework et `/opt/venv` agent execution) |
| Public adjacent | **Space Agent** (https://github.com/agent0ai/space-agent) = pivot produit polished : workspace réagençable, desktop app, version self-hosted. Time Travel (snapshots `/a0/usr`) y est développé puis backporté |

---

## Architecture

### Vue d'ensemble

Agent Zero est un **framework d'agents généraux** où l'agent **utilise un OS Linux comme outil principal**. La philosophie est radicalement différente de BoxIA : là où on assemble des agents Dify spécialisés appelant des HTTP tools curatés, Agent Zero pose un **shell Linux + Python REPL + browser Playwright** dans les mains d'un LLM et l'agent compose ses outils à la volée.

Cinq composants nucléaires :

1. **Boucle agent (`agent.py`)** — `Agent.monologue()` (lignes 372-535) tourne en `while True`, appelle le LLM, parse une JSON request `{thoughts, tool_name, tool_args}`, exécute le tool via `process_tools()` (l. 867-974), boucle jusqu'à ce que l'outil `response` soit appelé (`break_loop=True`). Le format texte est en lower-case quasi-télégraphique pour économiser les tokens (cf. `prompts/agent.system.main.role.md`).

2. **Hiérarchie multi-agents récursive** — chaque agent peut faire `call_subordinate` (`tools/call_subordinate.py`) qui crée un nouveau `Agent(self.agent.number + 1, ...)` avec son **propre contexte d'historique**, lance `subordinate.monologue()`, et renvoie le résultat. Le superior est tracé via `Agent.DATA_NAME_SUPERIOR`. Profondeur récursive non bornée (`A0 → A1 → A2 → …`).

3. **AgentContext (`agent.py:42-308`)** — état conversationnel global : id, log, paused, streaming_agent (qui écrit en ce moment), DeferredTask (le thread qui exécute la boucle). Une intervention user peut être envoyée mid-execution via `communicate(broadcast_level)` qui l'injecte dans `agent.intervention` et `handle_intervention()` la consomme à la prochaine `await`.

4. **Système d'extensions (`extensions/python/`)** — 27 hook points cycle-lifecycle (`monologue_start`, `message_loop_prompts_after`, `tool_execute_before`, `response_stream_chunk`, `chat_model_call_before`, …). Chaque hook = répertoire qui charge dynamiquement tous les fichiers `_NN_xxx.py` ordonnés par préfixe. Décorateur `@extension.extensible` sur les méthodes Agent rend tout le pipeline patchable sans toucher au core.

5. **Plugins (`plugins/`)** — couche au-dessus des extensions. Un plugin = dossier avec `plugin.yaml` (manifest) + sous-dossiers conventionnels `tools/`, `extensions/`, `webui/`, `api/`, `helpers/`, `prompts/`, `skills/`, `hooks.py`. Discovery automatique. Plugins core préfixés `_` (ex `_code_execution`, `_memory`, `_browser`, `_office`, `_oauth`, `_chat_branching`, `_time_travel`, `_a0_connector`). Plugins user dans `usr/plugins/`. Activation/désactivation via toggle files `.toggle-1` / `.toggle-0`.

### Flux récursif sub-agents (illustration)

```
User → Agent0 (profile=agent0) — boucle monologue
  └── tool: call_subordinate(profile=researcher, message="research X")
       └── Agent1 (profile=researcher) — boucle monologue, contexte vide
            └── tool: search_engine(query=...)
            └── tool: knowledge_tool(query=...)
            └── tool: response(text="findings")    ← break_loop
       ↑ retourne au parent, agent0 reprend sa boucle
  └── tool: code_execution_tool(runtime=python, code=...)
  └── tool: response(text=final answer)
```

Chaque agent **partage le `AgentContext` global** mais a son `History` propre → la pile est inspectable en UI (sub-agent panels). Quand on charge un chat persisté, les superior agents recréent la chain via `_process_chain` (`agent.py:283-302`).

### Sandbox Docker à deux runtimes Python

Détail clé (`AGENTS.md:51-63`) :
- **Framework runtime** `/opt/venv-a0` (Python 3.12) — le code Agent Zero, isolé.
- **Execution runtime** `/opt/venv` (Python 3.13) — où le tool `code_execution_tool` lance Python/Node/shell. C'est ce que voit le LLM quand il fait `pip install something`.

Cette double-isolation évite que l'agent casse sa propre stack en installant un package incompatible. C'est plus avancé que ce qu'on a chez BoxIA (où Dify exécute juste des Custom Tools HTTP, sans REPL).

### Mémoire (`plugins/_memory/`)

- Vector store local **FAISS** (`plugins/_memory/helpers/memory.py:8-13`), pas Qdrant. Persistant via `LocalFileStore` + cached embeddings.
- 3 zones : `MAIN` (souvenirs généraux), `FRAGMENTS` (extraits), `SOLUTIONS` (procédures qui ont marché).
- Tools exposés au LLM : `memory_save`, `memory_load`, `memory_delete`, `memory_forget`, `behaviour_adjustment` (réécrit le system prompt selon les requêtes user).
- Un patch `faiss_monkey_patch.py` pour ARM macOS 3.12.

### MCP intégration

Bidirectionnelle, c'est rare et notable :
- **Client MCP** (`helpers/mcp_handler.py`) — `MCPConfig.update(...)` charge des serveurs externes (stdio, SSE, streamable-http). Quand le LLM appelle un tool, `process_tools()` (`agent.py:894-911`) cherche d'abord côté MCP avant de fallback au `tools/` local.
- **Serveur MCP** (`helpers/mcp_server.py`) — Agent Zero expose **lui-même** une instance FastMCP qui permet à un autre Agent Zero (ou Claude Desktop, etc.) de l'appeler comme tool distant. ContextVar par requête isole les projets.

### Skills (norme `SKILL.md`)

Récente addition (cf. `helpers/skills.py`, `skills/` dans le repo). Format Markdown + frontmatter YAML proche du standard Anthropic Skills :

```yaml
---
name: a0-create-agent
description: Create a new Agent Zero agent profile…
trigger_patterns: ["create agent", "new agent profile", …]
allowed_tools: [...]
---
```

Skills activables global / per-project / per-chat (max 20). Sont **chargées contextuellement** dans le prompt seulement quand un trigger matche, pour ne pas saturer les tokens (cf. doc `architecture.md:142-145`). C'est exactement la même philosophie que les Anthropic Skills (skill-creator, etc.) — Agent Zero a embrassé le standard.

### Self-update (`helpers/self_update.py`)

Très avancé : choix de branche (`main`/`ready`/`testing`/`development`), tags remote cachés 60s, backup automatique de `/a0/usr` avant mise à jour, conflict policies (`rename`/`overwrite`/`fail`), pending update yaml + status yaml + log file. Déclenché via UI Settings, exécuté hors process (script `/exe/trigger_self_update.sh`). C'est sensiblement plus mature que notre `tools/install-update-watcher.sh` BoxIA.

### Time Travel (`plugins/_time_travel/`)

Snapshots du workspace `/a0/usr` (équivalent de `/data` chez nous), avec diff inspection, travel (charger un état passé) et revert. **Powered by Space Agent** d'après le README (l. 198-204). Pas un remplacement de Git, juste une safety layer pour le workspace agent.

### Universal Canvas (right-side panel)

Mention README l. 75-80 : surface partagée pour browser sessions, documents (DOCX/XLSX/PPTX via LibreOffice côté serveur, plugin `_office`), workspace history. C'est leur réponse à Claude Artifacts mais **rendu côté serveur** (donc Python/LibreOffice peut générer un xlsx natif avec charts, pas juste afficher du HTML inline).

---

## Features remarquables

| # | Feature | Chemin source | Pourquoi c'est intéressant |
|---|---|---|---|
| 1 | **Boucle agent récursive multi-agents non bornée** | `agent.py:372-535` + `tools/call_subordinate.py` | Chaque sub-agent a son propre contexte d'historique → on peut paralléliser cognitivement sans noyer le contexte parent. Profile-switchable (`researcher`, `developer`, `hacker`…). |
| 2 | **27 hook points d'extension** | `extensions/python/<hook_name>/_NN_xxx.py` | Patcher n'importe quoi du pipeline (avant/après LLM call, pendant streaming, à l'entrée de history, etc.) sans forker le core. Notre `lib/strip-think.ts` BoxIA ferait un excellent extension `response_stream_chunk`. |
| 3 | **Code execution dual-runtime** | `plugins/_code_execution/` + `AGENTS.md:51-63` | Python REPL persistant (sessions numérotées), Node.js, shell — le tout dans un container Python séparé du framework. C'est la pierre angulaire de leur philosophie « computer as a tool ». |
| 4 | **Browser tool natif Playwright avec WebUI viewer** | `plugins/_browser/tools/browser.py` + viewer JS | L'agent navigate avec des refs typées `[link 3]`, `[button 6]`, `[input text 8]`. Mode « Annotate » pour marker le DOM et envoyer des consignes. Supporte Chrome extensions installées dans la sandbox. |
| 5 | **A0 CLI Connector** | `plugins/_a0_connector/` | CLI `a0` qui bridge un terminal local avec une instance Agent Zero hébergée → l'agent peut piloter ton vrai filesystem hors Docker quand tu actives Read+Write. Mécanisme `WsRuntime` + `event_bridge`. |
| 6 | **Memory FAISS 3 zones + behaviour_adjustment** | `plugins/_memory/helpers/memory.py` | Mémoire long-terme partitionnée (main/fragments/solutions). Le tool `behaviour_adjustment` permet à l'agent de **réécrire son propre system prompt** suite à un feedback user, et la modif persiste. |
| 7 | **MCP bidirectionnel (client + serveur)** | `helpers/mcp_handler.py` + `helpers/mcp_server.py` | Importe des serveurs MCP externes (stdio/SSE/HTTP) et expose lui-même une API MCP pour qu'un autre agent l'appelle. ContextVar par requête pour multi-projets. |
| 8 | **Skills (`SKILL.md` standard)** | `helpers/skills.py` + `skills/` | Compatible Anthropic Skills standard. Activation contextuelle via `trigger_patterns` → ne charge la skill dans le prompt que si elle est pertinente, pour économiser les tokens. |
| 9 | **Plugin system full-stack** | `plugins/` + `helpers/plugins.py` | Manifest yaml + auto-discovery de `tools/`, `extensions/`, `webui/`, `api/`, `hooks.py`. Plugins peuvent embed leur propre UI Alpine.js + endpoints API + pages settings. Toggle global/per-project/per-chat. |
| 10 | **Self-update OTA avec branches multiples** | `helpers/self_update.py` | Choix branche `main`/`ready`/`testing`/`development`, backup `/usr` auto, pending+status yaml, conflict policies. Beaucoup plus mature que notre watcher BoxIA. |
| 11 | **Task scheduler (cron)** | `helpers/task_scheduler.py` + `tools/scheduler.py` | Tasks ad-hoc / scheduled (crontab) / planned (datetimes). Persistance `usr/scheduler/`. L'agent peut s'auto-programmer. |
| 12 | **STT/TTS local (Whisper + Kokoro)** | `helpers/whisper.py` + `helpers/kokoro_tts.py` | Pas de dépendance cloud pour la voix. Kokoro est tiny (300 Mo) et rapide CPU. Notre infra TTS Piper est sur la même philo mais on n'a pas Whisper côté STT (on délègue browser). |
| 13 | **Time Travel workspace snapshots** | `plugins/_time_travel/` | Diff + revert de `/a0/usr`. Différent de Git, optimisé pour les fichiers que l'agent crée/édite en boucle. |
| 14 | **OAuth Codex (account-backed plans)** | `plugins/_oauth/` | Auth flow device code pour utiliser ton plan ChatGPT/Codex au lieu d'API key payée. Roadmap : Gemini CLI, Claude Code subscriptions. C'est unique côté open source. |
| 15 | **Approval gate via secrets aliases** | `helpers/secrets.py:18-22` (`§§secret(KEY)`) | Format `§§secret(GITHUB_TOKEN)` dans les prompts → expansion runtime, masquage stream-time via `StreamingSecretsFilter`. Empêche les fuites partielles via chunks SSE. |
| 16 | **Chat branching** | `plugins/_chat_branching/` | Forker une conversation à un point donné pour explorer un alternative path sans perdre l'original. |
| 17 | **Bulk + topic summary auto** | `prompts/fw.bulk_summary.*.md` + `fw.topic_summary.*.md` | Compaction d'historique automatique quand contexte sature : résumés par topic puis bulk. Préserve la trace logique sans re-payer les tokens. |
| 18 | **Office artifacts (DOCX/XLSX/PPTX) server-rendered** | `plugins/_office/` + LibreOffice | Génère des fichiers Office natifs avec charts et formulas, pas juste du Markdown rendu. Document canvas dédié dans l'UI. |

---

## Comparatif avec BoxIA

| Dimension | Agent Zero | BoxIA | Verdict |
|---|---|---|---|
| **Philosophie agent** | Code-natif : l'agent a un Python REPL + shell + browser. Il **écrit/exécute du code** pour résoudre le problème. | Tool-natif via Dify : l'agent appelle des HTTP tools curatés (`list_connectors`, `install_workflow`, `gmail_search`…). | Choix structurant. Agent Zero = puissance maximale + risque d'attaques (RCE en local). BoxIA = surface d'attaque ciblée + UX/sécurité TPE-friendly. **Garder notre approche tool-natif pour le produit cœur, mais on peut emprunter un sandbox code-eval comme tool optionnel ouvert au admin (équivalent Code Interpreter)**. |
| **Récursivité multi-agents** | Native, illimitée : `call_subordinate(profile=...)` crée un Agent avec contexte vide et profile spécialisé. | Aucun mécanisme d'agent-appelle-agent. Chaque agent Dify est une boîte fermée. | Concierge BoxIA approche cette idée mais reste mono-niveau. **Remplacer notre Concierge mode `function_call` par un orchestrateur qui peut appeler `call_agent(slug, message)` + récupérer la réponse → permettrait au général de déléguer "lire mon Outlook + résumer" à l'agent vision pour une PJ image, par exemple**. |
| **Mémoire long-terme** | FAISS local + 3 zones (main/fragments/solutions) + tool `behaviour_adjustment` qui réécrit le system prompt. Embedded dans l'app. | mem0 service externe (sidecar `aibox-mem0`), best-effort, fact-extraction par LLM dédié. Best-of-class pour facts users. | mem0 est plus moderne que FAISS-local. **Garder mem0**. Mais regarder `behaviour_adjustment` : on n'a pas l'équivalent — un agent peut-il apprendre des préférences user durables (ton, langue, style) sans qu'on les hardcode ? À voler. |
| **Sandbox code execution** | Container dédié, Python REPL persistant, sessions numérotées, sessions SSH. | Aucun. Les "tools" sont des HTTP routes Next.js / Dify Custom Tools. | Pour TPE/PME on n'a peut-être pas besoin du REPL livré au user, mais en interne **l'option « j'autorise l'agent à exécuter un script Python pour analyser mon CSV de 200k lignes » manque cruellement** (cf. notre cas extract-doc + Pennylane). À adapter avec un sandbox restrictif (Pyodide WASM ? Container éphémère ?). |
| **Tool use / format** | JSON dirty-parsed `{thoughts, tool_name, tool_args}` côté response, fallback `unknown.py` si tool non trouvé. Tools = classe `Tool` qui hérite + override `execute()`. | Function calling natif qwen3 (depuis migration 0012). Tools = HTTP routes. | Approches équivalentes en puissance, mais notre function calling natif est plus robuste (validation de schema côté Ollama) et économise les retries `msg_misformat`. **Garder notre choix**. |
| **UI** | Alpine.js + Flask + WebSocket, ChatGPT-like avec Universal Canvas, chat branching, time travel, viewer browser, file browser, settings UI riche. | Next.js 15 App Router + Tailwind, UI plus moderne mais features plus limitées (pas de canvas multi-panels, pas de chat branching). | Notre stack est meilleure pour l'évolution UI, mais Agent Zero est plus mature côté UX agent-spécifique (sub-agent panels, intervention live, real-time stream). **Voler le pattern « intervention pendant un tool en cours » et le « streaming_agent ID » pour l'UX**. |
| **Déploiement** | Docker single-container `agent0ai/agent-zero:latest`. UI sur :80, runtime + agent dans 1 image. | Stack distribuée 33 containers (Authentik + Dify + n8n + Ollama + Postgres + Qdrant + …) déployée via `tools/deploy-to-xefia.sh` avec migrations versionnées. | Notre approche est plus pro pour produit clé-en-main multi-clients (chacun son box) mais lourde pour un solo dev. **Aucun changement à faire**. |
| **Multi-user** | Pas de notion de user/auth dans le core. Single-user. Une instance = un user. Possibilité d'OAuth uniquement pour le LLM Codex. | Authentik OIDC SSO + RBAC par connecteur + tier (free/pme/pme-plus) + audit log + RGPD scrub. | **Énorme avantage BoxIA**, central pour notre cible. À ne pas perdre de vue. |
| **Sécurité Python sandbox** | Container Docker (isolation host/container), pas de seccomp custom, pas de tenant isolation. README explicit : "Treat it with the same respect you would give a capable developer with shell access" (l. 219). | Pas de Python sandbox du tout, donc pas le problème. Approval gate (`lib/approval-gate.ts`) bloque les tools mutatifs sans confirmation user. PII scrub avant cloud (7 patterns FR). | Si on adopte un sandbox code-eval, **prendre leur approche conteneur isolé éphémère + ajouter notre approval gate par-dessus**. Ne JAMAIS lancer du code agent dans le process Next.js. |
| **Prompts** | 70+ fichiers `.md` dans `prompts/`, format quasi-télégraphique (lower-case, pas de ponctuation, économise les tokens) avec template `{{include}}` et expansion conditionnelle `{{if}}{{endif}}`. Inheritance par profil (`agents/<profile>/prompts/agent.system.main.specifics.md` override le default). | Prompts dans `services/setup/app/sso_provisioning.py` + migrations DB Dify. Stockés en base, pas en fichiers versionnables. | **Voler la mécanique de prompt files versionnés + template engine + inheritance par profile**. C'est plus testable et reviewable que des prompts en SQL/JSON. Migration `0011_inject_rag_search_v1.py` essaye déjà d'aller dans cette direction. |
| **MCP** | Client + serveur. Le serveur expose Agent Zero comme tool MCP appelable par d'autres agents (Claude Desktop, autre A0…). | Marketplace MCP servers (`lib/mcp-marketplace.ts` enrichi 2026-05-01) côté client uniquement. Pas de serveur MCP exposé. | **Exposer une API MCP « BoxIA-as-tool »** permettrait à un Claude Desktop de driver la box. Backlog V2. |
| **Voice (STT/TTS)** | Whisper local (STT) + Kokoro local (TTS) embarqués. | Piper TTS infra commitée (sprint V1.1) + délégation STT au browser (Web Speech API). | Kokoro est plus moderne que Piper. STT browser est suffisant pour TPE. **Backlog : tester Kokoro vs Piper sur la même infra**. |
| **RAG** | Knowledge folder `knowledge/<subdir>/` indexé dans la même FAISS que la mémoire. `knowledge_tool` côté agent. Format markdown + import `unstructured`. | Dify Knowledge Bases (Qdrant + reranker TEI), gérées via `lib/dify-kb.ts`. Plus pro pour multi-doc + métadonnées. | **Garder notre stack RAG Qdrant**, mais regarder leur pattern de pre-loading knowledge subdir au démarrage de la mémoire. |
| **Templates / marketplace** | Skills standards `SKILL.md` (compatible Anthropic), agents profiles (`agents/researcher/`, `developer/`, `hacker/`) avec metadata. | Marketplace FR templates Dify (`lib/boxia-fr-templates.ts`) + n8n + MCP. Très riche côté business (compta, RH, juridique). | Approches complémentaires. **Évaluer si nos templates marketplace pourraient suivre le format `SKILL.md`** pour interop future. |
| **Self-update** | Multi-branche (main/ready/testing/development), backup auto, conflict policies. | Watcher systemd → docker exec git pull + reset, single-branch main. | **À adapter** : ajouter au minimum un mode "testing" pour qu'on push une release sur xefia sans toucher la prod client. |
| **Approval / Sécurité actions** | Pas d'approval gate visible. Le user doit faire confiance au sandbox. Secret aliases `§§secret(KEY)` + StreamingSecretsFilter. | `lib/approval-gate.ts` BoxIA = banner UI orange `[Approuver]/[Refuser]`, params consommés depuis pending pas du body, TTL 5 min, audit log. Défense contre prompt injection. | **Énorme avantage BoxIA**. À ne pas perdre. Leur StreamingSecretsFilter est intéressant à voler pour empêcher les leaks de tokens via SSE chunks coupés. |

---

## À voler tel quel

1. **Format `prompts/*.md` versionné dans le repo + template engine `{{include}}` / `{{if}}` / `parse_file()`** (`agent.py:642-657`, `helpers/files.py`). Plus testable que stocker les prompts en DB Dify, et permet aux profiles d'override sans dupliquer. Migration suggérée : extraire les `pre_prompts` de `services/setup/app/sso_provisioning.py` vers `services/app/prompts/<agent>/system.main.md` et les injecter via une migration DB qui lit ces fichiers.

2. **Hook `response_stream_chunk` pour notre `lib/strip-think.ts`** (`agent.py:428-468`). On a déjà la logique mais elle est dans le proxy `/api/chat`. La sortir comme extension permettrait de la désactiver/customiser per-agent (ex : agent dev qui veut voir le `<think>`).

3. **Streaming secrets filter** (`helpers/secrets.py` `StreamingSecretsFilter` l. 30-100). Détecte les longest-suffix-prefix de secrets sur les chunks SSE et bufferise tant qu'on ne sait pas. Notre `pii-scrub.ts` ne marche que sur le texte complet ; en streaming on peut leak un IBAN partiel `FR76 3000 6000 0…` avant qu'on ait vu la fin. À porter en TS dans `lib/pii-scrub-stream.ts`.

4. **`§§secret(KEY)` placeholder format** (`helpers/secrets.py:18`). Plus lisible que `${SECRET_KEY}` qui peut collide avec du shell ou des templates frontend. Adopter pour notre stockage credentials chiffrées (`lib/cloud-providers.ts` aujourd'hui en clear dans le prompt).

5. **Skill standard `SKILL.md`** (`helpers/skills.py` + dossier `skills/`). On a déjà des templates Dify, mais formaliser un standard `SKILL.md` activable contextuellement par trigger patterns nous donnerait une marketplace inter-opérable avec Anthropic Skills + Agent Zero. Probablement V2.

---

## À adapter

1. **Sub-agent recursion + profiles** — porter `call_subordinate` à BoxIA. Au lieu de créer un nouveau context Dify, l'agent général (qwen3) appelle un agent spécialisé via `/api/agents-tools/call_agent` qui pose une question dans une conversation **éphémère** avec l'agent vision/comptable/juridique, récupère la réponse, et l'injecte comme tool result. Ça résout aussi le routing image de notre BUG-022 (le général pourrait déléguer à l'agent vision sans middleware côté nous).

2. **Code execution tool sandbox isolé** — équivalent du `_code_execution` plugin mais limité à un container éphémère et derrière approval gate. Use case BoxIA : « calcule-moi ces TVAs sur ce CSV de 5000 lignes » → l'agent écrit un script Python, le sandbox l'exécute, renvoie le résultat sans saturer le contexte LLM.

3. **27 hook points → adapter pour Next.js** — on n'a pas besoin des 27, mais les 5-6 critiques (`message_loop_prompts_after`, `tool_execute_before`, `response_stream_chunk`, `chat_model_call_after`) sont des points d'extension qu'on duplique aujourd'hui dans chaque route API. Regrouper dans un `lib/agent-pipeline.ts` avec des callbacks enregistrables.

4. **Time Travel pour `/data/`** — snapshots du workspace conversationnel + fichiers générés, avec diff + revert. Use case : « j'ai supprimé un fichier généré par l'agent il y a 2 jours, je veux le récupérer ». Aujourd'hui on le perd. À implémenter en SQLite + hardlinks COW si possible.

5. **Self-update multi-branche** — ajouter `RELEASE_CHANNEL=stable|testing|edge` au watcher systemd BoxIA. Permettrait à xefia (notre démo) d'être en `testing` pendant que les futurs clients sont en `stable`.

---

## À surveiller

1. **Universal Canvas + Time Travel orchestration** — Space Agent itère vite côté Canvas. Si une norme émerge (canvas as tool result format), on voudra suivre. Surveiller `agent0ai/space-agent`.

2. **A0 CLI Connector** — le pattern d'un CLI installé sur le poste client qui bridge avec un serveur Agent Zero distant (`a0` → ws → instance) est exactement ce qu'on devrait évaluer pour notre roadmap "BoxIA piloter mon poste". Pour l'instant on est confiné au navigateur.

3. **OAuth Codex / Claude Code account-backed** (`plugins/_oauth/`) — leur roadmap mentionne Gemini CLI + Claude Code via abonnements. Pour BoxIA Cloud Providers BYOK, on pourrait offrir « connecte ton ChatGPT plan » au lieu d'« entre une API key » → friction zéro pour les TPE qui ont déjà Plus.

4. **MCP server expose** — quand FastMCP devient mainstream, les TPE voudront probablement « pluguer ma BoxIA dans Claude Desktop » → tester `helpers/mcp_server.py` comme inspiration.

5. **Skills standardisation cross-vendor** — Anthropic Skills + Agent Zero alignés. Si ça devient la lingua franca des templates agent, on devrait migrer notre marketplace Dify-FR vers ce format.

---

## Pièges identifiés

1. **PIÈGE — Sandbox Docker ≠ sécurité prod**. Le README l. 219 admet : « Treat it with the same respect you would give a capable developer with shell access ». Pour TPE/PME multi-tenant on **ne peut pas** se permettre cette confiance. Si on adopte un code execution tool, **il faut isolation par tenant** (volumes par user, network namespaces, no host mount, ressources limitées) — pas leur modèle "1 user 1 box".

2. **PIÈGE — JSON dirty-parsing du stream LLM** (`agent.py:438-453`, `helpers/dirty_json.py`). Ils parsent le JSON tool call à la volée pendant le streaming et coupent le stream dès qu'ils ont un objet valide. Élégant mais fragile — les LLM peuvent émettre des `\n`, des trailing commas, des chaînes mal échappées qui font cracher le parser. Notre **function calling natif qwen3** est plus solide. **Ne pas régresser** vers leur approche dirty-JSON.

3. **PIÈGE — Profondeur récursive non bornée** (`tools/call_subordinate.py`). Un agent peut faire `call_subordinate` qui lui-même fait `call_subordinate`… il n'y a pas de limit explicite. Sur qwen3 14B local on saturerait la VRAM en quelques niveaux. Si on porte le pattern, **mettre un MAX_DEPTH=3** et un budget tokens cumulé.

4. **PIÈGE — Plugin `webui/` injection** — un plugin peut servir n'importe quel JS via `webui/`. Si un user installe un plugin malveillant via la marketplace, il a un XSS direct. Notre marketplace BoxIA doit rester **curatée** (pas d'install de plugin tiers arbitraire) ou avoir un sandbox iframe par plugin.

5. **PIÈGE — Pas de RBAC multi-user**. Tout l'auth d'Agent Zero est mono-user. Quand ils introduiront du multi-user (Space Agent l'aura probablement), regarder s'ils gardent le modèle "tout le monde voit tout" ou s'ils ajoutent ACL. Aujourd'hui Authentik + permissions BoxIA reste **notre avantage clé** pour le segment cabinet comptable / PME structurée.

6. **PIÈGE — `hooks.py` plugin runtime = framework venv**. Doc `AGENTS.md:140` explicite : `hooks.py` tourne dans `/opt/venv-a0`, donc un `pip install` dedans pollue le framework runtime. Si on prend l'inspiration du modèle plugin avec hooks, **séparer hard les deux runtimes ou interdire les hooks Python user**.

---

## Top-3 préconisations BoxIA

### 1. Adopter sub-agent delegation (call_agent tool) — PRIO HAUTE — 2-3j

**Quoi** : ajouter `services/app/src/app/api/agents-tools/call_agent/route.ts` qui prend `{slug, message}`, ouvre une conversation éphémère avec l'agent cible (via `lib/agents.ts` + `/api/chat`), attend la réponse complète, retourne le texte. Exposer comme tool dans le pre-prompt du Concierge **et** des agents généraux.

**Pourquoi** : résout 3 problèmes simultanés :
- routing image vers vision agent (BUG-022 historique) sans hack côté nous,
- spécialisation par domaine (« demande à l'agent juridique de checker cette clause »),
- meilleur usage du contexte (chaque sub-agent a son contexte vide, pas de pollution).

**Risques** : profondeur récursive → mettre MAX_DEPTH=2 et budget tokens via Langfuse trace. Latence multipliée → marquer ces appels comme non-cachés sinon le frontend bloque.

**Inspiration directe** : `tools/call_subordinate.py` + `prompts/agent.system.tool.call_sub.md`.

---

### 2. Streaming PII/secrets filter — PRIO HAUTE — 1j

**Quoi** : porter `helpers/secrets.py:30-100` en TypeScript dans `lib/pii-scrub-stream.ts`. État interne = `pending` buffer + `min_trigger=3`. À chaque chunk SSE Dify, on flush ce qui est sûr et on retient ce qui pourrait être un secret partiel. Au stream end, on flush le pending soit en clear (rien matché) soit en `***`.

**Pourquoi** : aujourd'hui on PII-scrub le texte complet avant envoi cloud (`lib/cloud-providers.ts` côté outbound), mais sur le **retour** SSE Dify→user on ne filtre rien. Si l'agent a accès à un connecteur leaky (ex : Pennylane retourne un IBAN non masqué dans une réponse), le user verra la chaîne complète streamée chunk-par-chunk avant qu'on n'ait pu intervenir.

**Risques** : ralentit légèrement le perceived TTFT (~30 caractères de buffer max). Acceptable pour une fonctionnalité security.

**Inspiration directe** : `helpers/secrets.py:30-130` (`StreamingSecretsFilter`).

---

### 3. Prompts en fichiers versionnés + profile inheritance — PRIO MOYENNE — 3-4j

**Quoi** : créer `services/app/prompts/<agent_slug>/` avec `system.main.md` + overrides optionnels `system.tool.<tool>.md`. Charger via `lib/prompt-loader.ts` au lieu d'avoir des chaînes en dur dans `services/setup/app/sso_provisioning.py`. Une migration `0013_load_prompts_from_files.py` lit le filesystem et PATCH les apps Dify. Template `{{include "agent.system.tools.md"}}` + `{{if vision}}` à la jinja-light.

**Pourquoi** :
- review-able en PR (diff lisible vs SQL UPDATE),
- testable (snapshot tests sur prompt rendu),
- par-agent override sans dupliquer,
- enables A/B testing prompts entre clients (champion vs challenger),
- permet de hot-reload sans toucher Dify (juste re-PATCH model_config),
- supporte mieux `i18n/` (déjà au format de fichiers chez nous).

**Risques** : conflit avec édition manuelle des prompts via console Dify (cabinet qui veut tweaker → on écrase à la prochaine migration). Solution : champ `_managed_by_boxia: true` dans le prompt, et n'override que celles-là.

**Inspiration directe** : `prompts/` dossier + `helpers/files.py` `parse_file()` + `agents/<profile>/prompts/agent.system.main.specifics.md` pattern d'inheritance.

---

> Fin de rapport. Sources principales : `agent.py`, `tools/call_subordinate.py`, `plugins/_code_execution/`, `plugins/_memory/`, `helpers/{mcp_handler,mcp_server,secrets,self_update,skills,task_scheduler}.py`, `prompts/`, `AGENTS.md`, `docs/developer/architecture.md`, `README.md`. Croisement BoxIA : `services/app/src/{lib/{strip-think,pii-scrub,memory,approval-gate,artifacts,conversation-tags},app/api/{chat,concierge,agents-tools}}/...`, `tools/migrations/*.py`.
