# AgenticSeek — Analyse pour BoxIA

> Source : `D:\IA_TPE_PME_POWER\.research-cache\agentic-seek\` (Fosowl/agenticSeek, GPL-3.0, ~31k★ GitHub Trending)
> Daté : 2026-05-05
> Cibles BoxIA : `services/app/src/`, `services/agents-autonomous/`, agents Dify

---

## 🪪 Fiche d'identité

| | |
|---|---|
| **Pitch** | "Private, local Manus alternative" — assistant agentique 100% local, voice-enabled, qui browse le web, code et planifie |
| **Origine** | Side-project FR (Fosowl, fosowl@github), parti en GitHub Trending sans roadmap ni funding |
| **Licence** | GPL-3.0 (contagieux — incompatible avec une distribution commerciale fermée) |
| **Cible** | Power-user perso/dev qui veut un Manus offline. Mono-utilisateur, mono-machine. |
| **Stack** | Python 3.10 / FastAPI + Celery + Redis + SearxNG + React frontend + Selenium (undetected-chromedriver) + Kokoro TTS + Whisper STT |
| **LLM** | Local par défaut (`ollama`, `lm-studio`), recommande Magistral / DeepSeek-R1 14B / Qwen ; cloud optionnel (OpenAI, DeepSeek, Anthropic, Together, OpenRouter, Google, MiniMax) |
| **Maturité** | "Active Work in Progress". MCP agent explicitement marqué `not functional yet` (`sources/agents/mcp_agent.py:9`) |
| **Multi-tenant** | Aucun. Pas d'auth, pas de RBAC, pas d'isolation utilisateur. CORS `allow_origins=["*"]` |

---

## 🏗️ Architecture

```
┌──────── React frontend (port 3000) ────────┐
│  CRA classique, polling sur /latest_answer │
└───────────────┬────────────────────────────┘
                │ HTTP
┌───────────────▼────────────────────────────┐
│  FastAPI backend (api.py, port 7777)       │
│  + Celery worker (in-process, Redis broker)│
└──┬──────────┬──────────┬───────────────────┘
   │          │          │
   ▼          ▼          ▼
[Router] [Interaction] [Speech (TTS/STT)]
   │
   ▼
┌─── AgentRouter (sources/router.py) ────────────────────────┐
│  1. Détection langue (LanguageUtility)                     │
│  2. Traduction → anglais                                   │
│  3. Estimation complexité (AdaptiveClassifier few-shot)    │
│       LOW → routing direct                                 │
│       HIGH → planner_agent                                 │
│  4. Vote BART (zero-shot HF) + LLM-router (safetensors local)│
│       → label parmi {talk, code, files, web, mcp}          │
└────────────────────────────────────────────────────────────┘
                       │
   ┌──────────┬────────┼────────┬──────────┬──────────┐
   ▼          ▼        ▼        ▼          ▼          ▼
[Casual]  [Coder]  [Browser] [File]   [Planner]    [MCP]
            │         │        │         │
            │         │        │         └── orchestre les autres en JSON {plan:[{agent,id,need,task}]}
            │         │        └── FileFinder + BashInterpreter
            │         └── Selenium undetected-chromedriver + searxSearch + form-filling
            └── Py/Bash/C/Go/Java/JS interpreters (subprocess, exec direct, sans sandbox)
```

**Boucles agent.** Le pattern central est une exécution itérative ReAct-like sans framework :
- Le LLM produit du texte avec des **blocks** ` ```python … ``` ` ou ` ```bash … ``` `.
- `Agent.execute_modules()` (`sources/agents/agent.py:255`) parse la réponse, extrait les blocks, exécute chaque tool, et **reinjecte le feedback** dans la mémoire de l'agent (`memory.push('user', feedback)`).
- Le coder boucle jusqu'à `exec_success` ou `max_attempts=5` (`code_agent.py:54`).
- Le browser boucle sur `make_navigation_prompt` jusqu'à `REQUEST_EXIT` (`browser_agent.py:357`).

**Mémoire.** `Memory` (`sources/memory.py`) garde l'historique brut + **compression optionnelle** via `pszemraj/led-base-book-summary` (un Longformer Encoder-Decoder 16k tokens local) qui résume quand le contexte sature. Persistance JSON dans `conversations/<agent_type>/`.

**LLM router model.** Stocké en clair dans `llm_router/model.safetensors` — un classifier `AdaptiveClassifier` (lib `adaptive-classifier`) entraîné few-shot sur ~250 exemples hardcodés dans `router.py` (`learn_few_shots_tasks`). Vote pondéré avec un BART `facebook/bart-large-mnli` zero-shot. Détection multilingue (en, zh, fr, ja…) avec traduction préalable.

**Browser stack.** `sources/browser.py` :
- `undetected_chromedriver` + `selenium-stealth` + `fake_useragent` pour échapper aux détections anti-bot.
- Profile Chrome temporaire UUID, support proxy, screenshots auto.
- Conversion HTML → markdown via `markdownify` puis fed au LLM.
- Extraction des `<a>` navigables et des `<input>` de formulaires + remplissage via syntaxe `[input_name](value)` parsée du LLM.

---

## ⭐ Features remarquables

1. **Routing multi-modèle hybride** (`router.py:370`) — vote pondéré par confiance entre **BART zero-shot** et un classifier custom local. Préprend une **traduction systématique vers l'anglais** pour stabiliser le routage multilingue. Few-shot complexité ("HIGH" → planner) en plus du label d'agent.
2. **Browser agent autonome avec form-filling** (`browser_agent.py:60`, `make_navigation_prompt`) — protocole texte simple : `Note: <fact>`, `Action: GO_BACK`, `[input_name](value)`. Robuste sur des LLMs 14B locaux.
3. **Planner JSON avec graphe de dépendances** (`planner_agent.py`, `prompts/base/planner_agent.txt`) — chaque sous-tâche a `{agent, id, need: [ids], task}`, et `update_plan()` permet de **replanifier dynamiquement** quand une étape échoue (boucle d'auto-correction).
4. **Code interpreters multi-langues** (`tools/{Py,Bash,C,Go,Java}Interpreter.py`) — exécution directe via `exec()` Python ou `subprocess`. Détection d'échec par regex sur stderr (`expected|errno|failed|traceback|invalid|exception|syntax|crash|core dumped`). Auto-retry du coder avec injection du feedback.
5. **Voice loopback complet** — STT Whisper (`speech_to_text.py`) écoute en continu un trigger word (`agent_name`), TTS Kokoro (`text_to_speech.py`) en `en/zh/fr/ja` avec voix sélectionnables. Désactivé en backend Docker (déps lourdes), pensé pour CLI host.
6. **Memory compression locale** (`memory.py:43`) — Longformer LED résume l'historique au-delà du `ideal_ctx` calculé par le model name (heuristique `(model_size/7B)^1.5 × 4k`). Tourne sur GPU si CUDA dispo.
7. **Stealth browsing** — undetected-chromedriver + user-agent rotation + selenium-stealth pour bypass Cloudflare/recaptcha basique. C'est efficace mais c'est **techniquement contraire aux ToS** de pas mal de sites.

---

## 🆚 Comparatif avec BoxIA

| Dimension | AgenticSeek | BoxIA | Verdict |
|---|---|---|---|
| **Cible** | Power-user solo, machine perso, "Jarvis" | TPE/PME 5-50 users, serveur shared on-prem | **Ne se recoupent pas** |
| **Auth / multi-user** | Aucun (CORS `*`, pas de session) | Authentik OIDC + NextAuth + RBAC + audit + PII scrub FR | BoxIA largement au-dessus |
| **Philosophie agent** | Multi-agent spécialisés (Casual/Coder/Browser/File/Planner/MCP), router classifier-based | 6 agents Dify (général qwen3 + vision + 4 spécialisés) + Concierge orchestrateur, function calling natif | **Approches différentes** : Seek = router ML hard-coded, BoxIA = LLM tool-call |
| **Routing entre agents** | BART + AdaptiveClassifier vote + traduction EN, modèle `safetensors` à télécharger | Concierge avec function calling Qwen3 + sélection d'agent côté UI | Seek est **plus déterministe** sur le routing, BoxIA plus souple sur les tools |
| **Replan dynamique** | `PlannerAgent.update_plan()` rejoue le JSON si une étape échoue | Pas implémenté côté Concierge (one-shot) | **Seek > BoxIA sur la résilience long-horizon** |
| **Web browsing** | Selenium undetected + form-filling autonome + screenshots + 16 résultats SearxNG | `web_search` via SearxNG read-only, **pas de navigation/scraping** | **Énorme delta** — Seek peut "browse", BoxIA juste search |
| **Code execution sandbox** | Aucun sandbox — `exec()` Python, `subprocess` shell sur l'host. Liste de mots-clés "unsafe" (`tools/safety.py`) trivialement bypassable (juste un `in cmd` substring match) | Pas d'interpreter agent côté BoxIA. Dify a Code Tool sandboxed | Seek prend des risques **inacceptables** pour notre cible |
| **Voice TTS/STT** | Kokoro TTS + Whisper STT, FR/EN/ZH/JA, multi-voix | TTS Piper en infra (commit `c06a339` du sprint V1.1), pas de STT | Match : on est en train de bâtir, Seek a déjà une UX continue |
| **Mémoire** | LED Longformer summarization + JSON local | Postgres conversations + tags + mem0 sidecar + Langfuse traces | BoxIA plus production-ready, Seek plus simple |
| **Frontend** | CRA (Create React App) + polling REST | Next.js 15 SSR + streaming SSE + theme branding + i18n FR/EN | BoxIA largement au-dessus |
| **Déploiement** | docker-compose.yml mono-fichier + 1 frontend + 1 backend + Redis + SearxNG | 33 containers, install.sh, OTA updates, Cloudflare tunnel, 0-touch client | Différentes ligues |
| **Marketplace / extensibilité** | MCP agent placeholder (`not functional yet`) | Marketplace Dify-FR + n8n + MCP + OAuth providers + Concierge auto-install | BoxIA largement au-dessus |
| **Langues** | en/zh/fr/ja avec traduction systématique vers EN | FR-first, i18n FR/EN | Seek mieux sur le routing multilingue ; BoxIA mieux sur la qualité FR (qwen3:14b natif) |
| **Sécurité supply-chain** | Tools de scraping qui violent ToS, code interpreter sans sandbox, GPL-3.0 contagieux | Approval gate Concierge, PII scrub, audit log, OIDC | Seek = **dette de sécu massive** |
| **Function calling** | Pas utilisé — protocole textuel ` ```block ``` ` parsé au regex | Migration en cours vers function_call natif qwen3 (commit `c18138e`) | BoxIA va dans le bon sens |
| **Production-readiness** | Side-project explicite, pas de tests d'intégration sérieux | 60+ tests, smoke tests, migrations versionnées, deploy script | Pas comparable |

---

## 🟢 À voler tel quel

1. **Le pattern de re-planification** (`planner_agent.py:184` `update_plan()`)
   Quand une sous-tâche échoue, le LLM réécrit le JSON `plan` à partir de l'étape qui plante. Notre Concierge actuel fait du tool-call one-shot ; sur des tâches multi-step (ex: "trouve la facture 2024 de X dans Pennylane, télécharge le PDF, envoie-la par mail"), c'est exactement ce qu'il manque. Coût : ~150 lignes côté Concierge, gros gain UX.

2. **Le format de prompt browsing** (`browser_agent.py:92` `make_navigation_prompt`)
   Le protocole `Note: <fact>` / `Action: NAVIGATE/GO_BACK` / `[input_name](value)` est **diaboliquement simple** et marche sur Qwen3 14B. Si on veut un jour un agent navigation web (déjà en backlog implicite vu qu'on a SearxNG mais pas de scrape), c'est le template à reprendre.

3. **L'estimation de complexité avant routing** (`router.py:401` `estimate_complexity`)
   Few-shot HIGH/LOW → décide si on dispatche au planner ou au tool direct. C'est un *circuit breaker* contre les LLMs qui tentent de tout faire en un seul tool-call. À porter dans le prompt système du Concierge.

---

## 🟡 À adapter

1. **Memory compression LED-Longformer** (`memory.py`)
   Modèle `pszemraj/led-base-book-summary` ~150 Mo, GPU-friendly, summarise au-delà d'un seuil de tokens. Notre approche actuelle (Postgres + Langfuse) garde tout. Quand un user aura 500 messages dans une conv, on aura le problème. L'idée : appeler ce model sur les vieux messages avant de les renvoyer au LLM. Adapter : pluguer dans `services/app/src/lib/memory-pack.ts` (à créer).

2. **Router classifier hybride BART + custom**
   Pour notre Concierge, on est sur du LLM tool-call. Mais pour la sélection **d'agent Dify** (général vs vision vs spécialisé), on pourrait éviter d'appeler le LLM principal et utiliser un classifier léger local (50ms vs 2s). La piste : entraîner un `AdaptiveClassifier` sur nos requêtes audit log historiques.

3. **TTS multi-voix Kokoro** vs Piper qu'on a commité
   Kokoro a `ff_siwis` pour le français. À benchmarker contre Piper sur la qualité FR. Non bloquant.

4. **Detection multilingue + traduction préalable**
   On est FR-first mais nos clients TPE peuvent recevoir des emails EN/IT. Le pattern `LanguageUtility` de Seek (langdetect + LibreTranslate-style) pourrait aider l'agent général à normaliser avant tool-call.

---

## 🔵 À surveiller

- **Trajectoire produit** : 31k★ sans roadmap ni funding → instabilité. Ne pas en dépendre, juste piller des idées.
- **Browser-use libraries** : Seek est sur Selenium pur. L'écosystème va vers **browser-use** / **playwright-mcp** / **stagehand**. À retracker dans 6 mois.
- **MCP agent** : explicitement `not functional yet` mais c'est exactement ce qu'on absorbe avec Dify+nos endpoints. Si Seek le finit avant nous, regarder leur protocole.
- **AdaptiveClassifier (lib `codelion/adaptive-classifier`)** : few-shot incremental sur HF transformers. Intéressant pour catégoriser les emails entrants côté connecteur Outlook sans dépendre d'un LLM 14B.

---

## 🔴 Pièges identifiés

1. **Sécurité du code interpreter** : `tools/PyInterpreter.py:41` fait `exec(code, global_vars)` direct dans le process backend. Le `unsafe_commands_unix` (`tools/safety.py:4`) check par `any(c in cmd for c in unsafe_commands_unix)` — `cd /tmp; rm -rf /` passe parce que… enfin parce que c'est juste une recherche de substring sur les bons mots et qu'il suffit d'écrire `r''+'m'` en Python pour bypass. **À ne JAMAIS reproduire** côté BoxIA. Si on veut un coder agent un jour, sandbox Docker obligatoire (Dify Code Tool fait ça).

2. **CORS `allow_origins=["*"]` + pas d'auth** (`api.py:55`). Sur le LAN d'un user solo c'est ok, sur xefia ce serait catastrophique.

3. **GPL-3.0 contagieux**. On ne peut **pas** copier-coller leur code dans le repo BoxIA si on vise la distribution commerciale. **Réimplémenter les patterns**, ne pas vendoriser.

4. **Le `safetensors` du LLM router** (`llm_router/model.safetensors`) est téléchargé via `dl_safetensors.sh` depuis HF. Si HF down ou repo private, l'app ne démarre pas. Pour notre Concierge, on n'aurait pas ce single-point-of-failure si on garde le routing LLM-based.

5. **Anti-bot stealth**. `undetected_chromedriver` + `selenium-stealth` violent les ToS de Google/Cloudflare/etc. Pour un produit B2B vendu à des PME, c'est un **risque juridique** à ne pas reproduire. Si on browse, on browse via APIs ou avec le user-agent identifié.

6. **Pas de tests d'intégration** — `tests/` contient du smoke test minimal. Leur taux de bug en prod doit être énorme, ils s'en sortent parce que c'est mono-user.

7. **Aucun isolation par worker/conv** — `Memory` est attaché à l'instance Agent qui est un singleton dans `Interaction`. Mono-thread implicite. Notre infra Postgres-backed conv est plus saine.

---

## 🎯 Top-3 préconisations BoxIA

### 1. Ajouter un nœud "replan" dans le Concierge (inspiré `update_plan`)
**Quoi.** Quand un tool-call du Concierge retourne `error`/`failure`, ne pas juste faire `return error` — réinjecter dans le prompt avec "Here is what failed at step N, rewrite the rest of your plan, do not change steps already done", relancer le LLM, comparer le nouveau plan, exécuter la suite.
**Où.** `services/app/src/app/api/concierge/decide/route.ts` + un nouveau `services/app/src/lib/concierge-replan.ts`.
**Coût.** ~1 jour. Pas de breaking change.
**Gain.** Robustesse sur les chaînes "browse → download → email" qui aujourd'hui plantent en silence dès la 1re erreur.

### 2. Voler le protocole `make_navigation_prompt` pour bâtir un BrowserAgent BoxIA
**Quoi.** On a déjà SearxNG (`services/search/`). Ajouter un container `boxia-browser` minimal (Playwright headless, **pas Selenium stealth**), exposer un tool `web_navigate` au Concierge avec le pattern `Note:` / `Action:` / `[input](value)` de Seek. **Sans le stealth/anti-bot** — on n'a pas besoin de bypass, nos cas d'usage TPE/PME (lire le portail Pennylane public, scraper INSEE, télécharger une facture EDF) sont sur des sites coopératifs.
**Où.** Nouveau `services/browser-agent/` (Python + Playwright) + tool `services/app/src/app/api/agents-tools/web_navigate/route.ts` + approval gate (mutatif si form-fill).
**Coût.** 3-4 jours.
**Gain.** On débloque le cas "lis-moi le dernier rapport URSSAF de mon compte" qui est en attente depuis 2 sprints.

### 3. Memory compression sur les conversations longues
**Quoi.** Quand `messages.length > 30` dans une conversation, lancer un job `npx pszemraj/led-base-book-summary` (ou équivalent qwen3 résumé prompt) en background, remplacer les N messages les plus anciens par un seul `system: "Résumé des messages 1-25 : …"`. Garder les 5 derniers messages bruts.
**Où.** Migration `tools/migrations/0013_memory_compression.py` (job background + table `conversation_summaries`) + hook côté `services/app/src/app/api/chat/route.ts` qui lit le résumé au lieu des vieux messages.
**Coût.** 2 jours.
**Gain.** Vraies conversations longues qui ne saturent pas le contexte qwen3 (32k mais on tape vite à 24k avec les RAG-search). Différenciant vs ChatGPT côté privacy + qualité long-horizon.

---

## Annexes

**Chemins clés AgenticSeek :**
- Router : `sources/router.py`
- Agent base : `sources/agents/agent.py:255` (`execute_modules`)
- Browser agent : `sources/agents/browser_agent.py:331` (process loop)
- Planner : `sources/agents/planner_agent.py:184` (`update_plan`)
- Memory + compression : `sources/memory.py:43`
- Code interpreters : `sources/tools/{Py,Bash,C,Go,Java}Interpreter.py`
- Safety (insuffisante) : `sources/tools/safety.py`
- TTS Kokoro : `sources/text_to_speech.py`
- API FastAPI : `api.py`
- Compose : `docker-compose.yml` (4 services)
- LLM router (à dl) : `llm_router/dl_safetensors.sh`
- Prompts agents : `prompts/base/*.txt`

**Chemins BoxIA croisés :**
- Concierge tools : `services/app/src/app/api/agents-tools/` (16 tools)
- Approval gate : `services/app/src/lib/approval-gate.ts`
- Web search SearxNG : `services/app/src/app/api/agents-tools/web_search/route.ts`
- Agents Dify : `services/app/src/app/api/agents/`
- Agents autonomes (LangGraph) : `services/agents-autonomous/app/graphs/`
- Speech (TTS Piper en cours) : `services/app/src/lib/use-speech.ts`
