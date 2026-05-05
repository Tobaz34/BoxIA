# Observer AI — Analyse pour BoxIA

> Source : `D:\IA_TPE_PME_POWER\.research-cache\observer-ai\` (clone Roy3838/Observer, MIT).
> Date d'analyse : 2026-05-05.

## Fiche d'identite

| Champ | Valeur |
|---|---|
| Repo | https://github.com/Roy3838/Observer |
| Licence | MIT |
| Auteur | Roy Medina (community: Discord/YouTube/TikTok actifs) |
| Stars (estim.) | quelques milliers, communaute active |
| Stack | React + Vite + TypeScript (frontend), FastAPI Python (api), Rust + Tauri (desktop), Rust CLI, Docker (deprecated) |
| LLM backbone | Ollama / llama.cpp / OpenAI compat / WebGPU transformers.js (Gemma 3n in-browser) |
| Mode hosting | 1) WebApp `app.observer-ai.com` + auth + paid compute 2) Desktop app Tauri auto-bundlee llama.cpp 3) Docker (deprecated) 4) BYO `v1/chat/completions` |
| Pitch | "Local micro-agents that observe, log and react" |

Slogan operationnel : un agent = `SENSORS -> MODEL -> TOOLS`, en boucle cadencee (`loop_interval_seconds`), 100 % cote client (le browser/Tauri capture, pas le serveur).

## Architecture

### Top-level structure repo
```
observer-ai/
  app/                    # frontend React + desktop Tauri
    src/utils/            # COEUR du framework agents (main_loop, pre/post-processor, sensors, tools)
    src/components/       # UI : AgentCard, EditAgent, AICreator (wizard simple + multi)
    desktop/              # wrapper Tauri (Rust) + bundling llama.cpp/server
    plugins/              # plugins Tauri custom
  api/                    # FastAPI : marketplace SQLite + compute proxy + payments + Twilio
  observer-ollama/        # proxy Python local Ollama -> v1/chat/completions
  cli/                    # Rust CLI
  docker/                 # compose deprecated (Ollama + observer_app + Docker socket mount !)
```

### Le runtime agent (le coeur)

Tout tourne autour de `app/src/utils/main_loop.ts` :

1. `startAgentLoop(agentId)` -> `getRequiredStreamsForPrompt(systemPrompt)` extrait les placeholders (`$SCREEN`, `$CAMERA`, `$MICROPHONE`...) puis demande au `StreamManager` les media streams correspondants (`getDisplayMedia`, `getUserMedia`).
2. `setInterval(executeIteration, intervalMs)` fait du **metronome** a `loop_interval_seconds` (typique : 5 s, 10 s, 60 s).
3. `executeAgentIteration` :
   - `preProcess` (`pre-processor.ts`) : substitue chaque `$VARIABLE` dans le system prompt -> remplace `$SCREEN` par une frame base64 attachee, `$SCREEN_OCR` par OCR (Tesseract.js charge en lazy), `$MEMORY[@otherAgentId]` par le contenu IndexedDB d'un autre agent, `$CLIPBOARD` via `navigator.clipboard.readText()`, `$MICROPHONE`/`$SCREEN_AUDIO` via subscribers Whisper transformers.js.
   - `ModelManager.sendPrompt(modelName, processedPrompt, token, stream=true, onChunk, onReasoningChunk)` : route soit vers `localhost:3838` (proxy Tauri/Docker -> Ollama), soit endpoint OpenAI compat distant (Gemini, Fireworks, OpenRouter, observer-ai cloud).
   - `postProcess` (`post-processor.ts`) execute le bloc `code` de l'agent dans un sandbox `new Function()` (cf. `handlers/javascript.ts`) avec un contexte injecte de tools et de variables (`response`, `screen`, `camera`, `microphone`, `imemory`, `time()`, `sleep()`, `notify()`, `sendEmail()`, `sendDiscord()`, `setMemory()`, `startAgent()`, `stopAgent()`...). Si le code commence par `#python`, lazy import Jupyter Server WebSocket pour exec Python (deprecated).
4. **Change detection** (`change_detector.ts`) : avant d'appeler le LLM, compare l'iteration courante a la precedente (Levenshtein sur texte + dHash + pixel diff selon mode "DHashOnly / PixelDifferenceOnly / Hybrid"). Si rien a change, **skip l'inference** et reutilise `lastResponse` cache. Economie GPU enorme.
5. `IterationStore` : sessions IndexedDB, chaque iteration a un id, persiste prompts/responses/sensor data pour replay debug.
6. `recordingManager` + `startClip()/stopClip()/markClip()` : enregistre n'importe quel media stream actif et stocke les clips dans IndexedDB (`recordingsDB.ts`), consultable via UI `RecordingsViewer`.
7. `pauseAgentLoop(durationMs)` + `wakeAgentLoop` : un agent peut s'auto-endormir.
8. `stopAgentLoop` : libere streams via le `StreamManager` (refcount par agent), arrete recorder si dernier agent.

### Sensor expansion (placeholders en clair)

`pre-processor.ts` declare un `Record<placeholder, handler>` :
- `$SCREEN`, `$SCREEN_OCR`, `$SCREEN_AUDIO`
- `$CAMERA`, `$CAMERA_OCR`
- `$MEMORY`, `$MEMORY@<agentId>` (cross-agent memory !)
- `$IMEMORY`, `$IMEMORY@<agentId>`, `$IMEMORY_OCR`
- `$CLIPBOARD`
- `$MICROPHONE`, `$ALL_AUDIO`

Whisper tourne dans le browser via `transformers.js` (OWUI-style WebGPU). C'est ce qui permet 100 % local sans backend Python.

### Tools (post-processing JS sandbox)

Cf. `handlers/javascript.ts` (1000+ lignes). Le contexte injecte propose :
- Memoire texte/image cross-agent
- Notif : `notify` (browser), `system_notify` (OS via Tauri), `overlay`, `message`, `ask` (dialog modal)
- Messageries via backend cloud auth + token : `sendEmail`, `sendSms`, `sendWhatsapp`, `sendTelegram`, `sendDiscord` (webhook direct), `sendPushover`, `sendGotify`, `call` (Twilio TTS)
- Recording : `startClip/stopClip/markClip/getVideo`
- Lifecycle : `startAgent`, `stopAgent`, `time`, `sleep`
- Desktop only (Tauri) : `click('left'|'right')`, `celebrate()`

### Marketplace

`api/marketplace.py` : FastAPI minimaliste, SQLite locale (`marketplace.db`) avec table `agents(id, name, description, model_name, system_prompt, loop_interval_seconds, code, memory, author, author_id, date_added)`. Endpoints :
- `GET /agents` : liste
- `GET /agents/{id}`
- `POST /agents` : INSERT OR REPLACE (overwrite par id, pas de versioning)
- `GET /agents/by-author/{author_id}`
- `GET /agents/statistics`

Cote client `CommunityTab.tsx` + `AgentImportHandler.tsx` pull la liste et un import/clic = INSERT IndexedDB local.

### Compute proxy

`api/compute.py` (17k) + `api/*_handler.py` : reverse proxy authentifie qui forward `v1/chat/completions` vers Gemini/Fireworks/OpenRouter avec quota par user (modele freemium). `payments_router` integre Stripe. Cote business : Roy revend du compute aux users qui n'ont pas de GPU, ce qui finance le projet.

### Sandbox security

`handlers/javascript.ts` lignes 1-40 : commentaire explicite. Le `new Function()` execute du code **utilisateur stocke en IndexedDB**, **pas** la sortie LLM. La sortie LLM est passee en variable runtime (`response`). Donc pas d'injection prompt -> code. Attention notee : si l'utilisateur fait `eval(response)` lui-meme, il se met en danger.
`code_sanitizer.ts` detecte les fonctions sensibles (`sendEmail`, `sendSms`, etc.) avant partage marketplace pour prompter l'auteur a remplacer ses coordonnees par des placeholders.

## Features remarquables

1. **Change detection a 4 niveaux** (`change_detector.ts`)
   - Levenshtein sur le texte du prompt processe
   - dHash (perceptual hash) sur les images, mode "DHashOnly" pour camera, "PixelDifferenceOnly" pour UI testing, "Hybrid" qui escalade vers pixel diff seulement quand dhash >= 0.998 (sequence quasi-identique)
   - Resultat : economie LLM massive sur les workflows "watch the screen 24/7" (90 %+ d'iterations skipped en pratique sur du screen statique).

2. **Cross-agent memory** (`$MEMORY@otherId`, `$IMEMORY@otherId`)
   Permet de chainer des agents : agent A scrute, ecrit dans `setMemory("solver", ...)`, agent B (dont le system prompt contient `$MEMORY@<self>`) lit et resout. Pattern "extracteur + raisonneur" documente dans `system_prompt.ts`.

3. **Auto-pause / auto-wake / `sleep(ms)`**
   L'agent peut decider lui-meme de se mettre en veille X minutes (ex: "il fait nuit, dors 8h"). `pauseAgentLoop` + bus d'evenements (`agent-sleep-start`/`agent-sleep-end`).

4. **Multi-agent creator IA** (`multi_agent_creator.ts` + `MultiAgentCreator.tsx`)
   Conversation guidee qui genere des **packs d'agents** (3 a 5 agents synchronises) en un coup, format `$$$ ... $$$` YAML repete. Le LLM-creator connait le DSL Observer (sensors + tools + cross-agent memory) et orchestre.

5. **Whisper / OCR full-browser**
   `transformers.js` charge un Whisper et un Tesseract en WebGPU. Aucun backend pour la transcription. Latence acceptable sur un laptop moderne, zero cout serveur.

6. **WebGPU LLM (Gemma 3n) bundle**
   `ModelHub.tsx` permet de telecharger Gemma 3n e2b/e4b dans IndexedDB et inferer in-browser. Crashe sur mobile, mais sur desktop = "1 click and you have an LLM" sans Ollama.

7. **Streaming reasoning**
   `onReasoningChunk` separe du `onStreamChunk` pour les modeles a `<think>...</think>` (DeepSeek, Qwen3, etc.). Affiche en UI "Thinking..." puis "Response". Pertinent pour notre Qwen3.

8. **Tauri desktop wrapper avec llama.cpp bundle**
   `app/desktop/Cargo.toml` + `tauri.conf.json` : binaire signe (`.signpath`) Win/Mac/Linux, llama-server bundled, mDNS/network discovery, click natif systeme, native notifications. **Zero install complexe**, `.exe` -> tu as un agent observer.

9. **Recording manager refcounte**
   Si plusieurs agents partagent un screen stream, recordingManager garde une seule capture, refcount par agent, `forceStop` quand le dernier libere.

10. **Sandbox confirmation dialog `ask()`**
    L'agent peut demander confirmation utilisateur via une modale OS native (Tauri) avant action mutative. Approval gate cote client, equivalent de notre Concierge "decide" mais cote desktop natif.

## Comparatif avec BoxIA

| Dimension | Observer AI | BoxIA | Verdict |
|---|---|---|---|
| **Nature des agents** | Micro-agents loops cadencees (5-60 s), code JS sandbox au-dessus du LLM | Agents Dify (general/vision/specialises) en chat REPL one-shot, plus 1 Concierge function-call | Observer = **automation passive** ; BoxIA = **assistant conversationnel**. Tres complementaire. |
| **Declencheurs / triggers** | Cron interne metronome + change detection (skip si rien ne bouge) + `sleep()`/`startAgent()`/`stopAgent()` reentrants | n8n cron pour workflows, mais cote agent : juste user-driven (chat) | Observer **pulverise** BoxIA cote triggers. n8n on a, mais aucun pont "agent qui se reveille seul". |
| **Vision** | qwen2.5vl/Gemma3 via Ollama, screen capture browser/Tauri, frame base64 -> message multimodal OpenAI compat. Vision sur **screen live** + camera + Image Memory cross-agent. | qwen2.5vl:7b cote Ollama, Dify accepte upload image en chat. **Pas de capture screen**, pas de continuous video. | Observer fait du **passive vision streaming** que BoxIA n'a pas. |
| **Marketplace agents** | SQLite simple, INSERT OR REPLACE par id, public, par auteur. Champs : `system_prompt + code + loop_interval`. Pas de versioning. | `marketplace_dify_fr` (templates `.yml` Dify) + `marketplace_n8n` (workflows JSON) + `marketplace_mcp_servers`. Provisioning par migrations versionnees. | BoxIA plus **mature/structure** (versioning, multi-format). Observer plus **virale** (1-click upload depuis l'UI). |
| **Partage agents** | Bouton "Upload to Community" dans `EditAgentModal`, code sanitizer avertit avant push (PII), auteur identifie via auth Observer cloud | Pas d'upload depuis l'UI. Templates ajoutes via PR repo + migration. | Observer **gagne** sur la viralite. BoxIA gagne sur la curation. |
| **Deploiement** | Desktop one-click (Tauri exe signe Windows/Mac), WebApp SaaS, ou Docker (deprecated) | Stack Docker 33 containers sur serveur dedie + provisioning automatise (Authentik/Dify/n8n) | Pas comparable : Observer = appli end-user, BoxIA = appliance entreprise. |
| **Securite screen** | Le user CHOISIT le tab/window/screen via `getDisplayMedia` ; rien ne quitte le browser sauf vers le LLM choisi (local par defaut). PII modal d'avertissement avant partage marketplace. | N/A (pas de screen) | Observer a un modele **opt-in granulaire** par agent (un agent ne voit que le crop configure via `setAgentCrop`). |
| **Multi-user** | Mono-user par browser/instance (auth observer cloud pour quota/payments uniquement) | Multi-user Authentik OIDC + RBAC + audit log | BoxIA **gagne** clairement sur ce volet. |
| **Langues** | EN dominant ; system prompts FR fonctionnent (modele dependant) ; pas d'i18n UI | i18n FR/EN | BoxIA gagne. |
| **Memoire long-terme** | IndexedDB par agent (texte + images), pas de RAG, pas de Qdrant | mem0 + Qdrant + Dify Knowledge Base + RAG hybride | BoxIA enormement plus puissant. |
| **PII / RGPD** | `code_sanitizer` detecte hardcoded creds avant partage. Pas de scrub LLM. | PII scrub 7 regex FR avant push cloud BYOK + audit log | BoxIA gagne. |
| **Function calling** | Pas de tool-calling natif. Pattern : prompt force le modele a sortir un mot cle, code JS post-process branche les tools selon `response.includes("...")`. | Function calling natif Qwen3 + Concierge fonctionnel | BoxIA plus moderne sur ce point. |

## A voler tel quel

1. **Le pattern `loop_interval_seconds` + change detection avant LLM** (`main_loop.ts` + `change_detector.ts`). Code TypeScript portable directement, dependances zero (sauf un dHash util ~100 lignes). C'est la fondation de toute "automation passive" et l'idee de comparer prompt/image avant d'appeler le modele economise un GPU. **Direct vol** : creer `services/app/src/lib/agent-watcher/` avec l'idee.

2. **Le DSL `$VARIABLE` avec resolution lazy au pre-processing** (`pre-processor.ts`). Tres elegant pour ecrire des prompts factorisables. On a deja `[RAG-SEARCH-V1]` et `[FILE:...]` chez nous, generaliser le pattern en `$RAG`, `$MEMORY`, `$WORKFLOW@id`, etc.

3. **Le `code_sanitizer` regex-based pour detecter creds avant partage marketplace**. 60 lignes, plug-and-play sur notre marketplace n8n et Dify-FR : on previent un user de pousser un agent qui contient un email/webhook/cle API hardcodee.

4. **Streaming `onReasoningChunk` separe** pour Qwen3 thinking. Chez nous on `strip-think` cote backend. Observer le **garde** et l'affiche en collapsible "Thinking...". Pertinent pour BUG-005 et la transparence.

5. **`ask(question)` confirmation dialog** : on a deja le Concierge approval gate cote backend, mais Observer l'a directement dans le sandbox JS. Ca peut nous inspirer un widget reutilisable cote Chat.

## A adapter

1. **Marketplace partage 1-clic** : porter chez nous = bouton "Publier cet agent" dans `/Discuter/configurer agent` -> POST vers un endpoint qui valide + sanitize + cree une PR auto sur le repo `marketplace_dify_fr`. Reduit la barriere a l'entree pour la communaute interne.

2. **Multi-agent creator conversational** : adapter `multi_agent_creator.ts` -> notre Concierge peut **proposer une equipe d'agents** plutot qu'un seul. Pertinent pour des scenarios "Je veux digerer ma boite mail Outlook + classer + repondre" qui requiert 3 agents Dify chaines.

3. **Auto-pause / sleep** : exposer `pauseAgent(durationMs)` dans n8n et Dify pour qu'un agent puisse s'auto-mettre en veille (ex: "vendredi 18h, je reprends lundi 8h"). Notre Concierge a la prim mais pas le sleep.

4. **Recording manager** : utile pour le mode demo / replay debug client. Pas prioritaire mais facile a integrer dans `langfuse` qu'on a deja.

5. **Cross-agent memory** : `$MEMORY@<agentId>` -> chez nous transposable a `mem0` namespace par agent. On peut donner aux agents Dify un acces lecture aux memoires d'autres agents via une variable `[MEM:<agent_slug>]`.

## A surveiller

1. **WebGPU LLM in-browser (Gemma 3n)** : la communaute IA on-device avance vite. Si Chrome stabilise WebGPU + un Qwen3 GGUF tourne in-browser, BoxIA pourrait offrir un mode "workstation only, zero serveur" qu'on ne peut pas faire avec Ollama. A reverifier dans 6 mois.

2. **Tauri 2.x app stack** : Observer est l'un des projets les plus aboutis sur Tauri 2 (signing, capabilities, bundle llama.cpp). Si un jour BoxIA veut un client desktop officiel (par exemple agent local connecte au serveur de bureau), regarder `app/desktop/` est la reference.

3. **Twilio whitelisting model** : Observer demande aux users d'envoyer un sms de validation a un numero Observer pour activer `sendSms()`. Process anti-spam interessant si on ouvre des connecteurs SMS metier.

4. **observer-ollama proxy** : un proxy local Python qui translate `v1/chat/completions` -> `ollama` legacy `api/generate`. Si Ollama deprecate son endpoint legacy, on a deja le pattern.

## Pieges identifies

1. **Docker compose deprecated avec mount Docker socket** (`docker/docker-compose.yml` ligne 40-49) : monte `/var/run/docker.sock` pour permettre `docker exec` depuis l'UI -> security nightmare sur un serveur multi-tenant. **Ne pas reproduire.** Notre runner de migrations est plus sain.

2. **`new Function()` sandbox** : Observer le justifie comme safe car le code n'est pas LLM-genere. Mais marketplace public + INSERT OR REPLACE = un user peut publier un agent malveillant qui s'install par 1-clic chez d'autres. Notre Code Owners + PR + migration approach est plus safe pour un marketplace officiel.

3. **`marketplace.db` sans versioning** (`api/marketplace.py`) : `INSERT OR REPLACE` ecrase l'agent existant. Si Roy upload v2 buggy de son agent populaire, tout le monde qui re-importe casse. **Ne pas faire ca chez nous** : on a deja les migrations versionnees.

4. **Whisper transformers.js** est instable sur Safari / mobile (chargement modele 100+ Mo, OOM). Observer documente le bug. Si on porte WhisperJS, prevoir fallback serveur Whisper Faster.

5. **Pas de RBAC / multi-user** : Observer suppose 1 user par instance. Pour le porter en mode entreprise BoxIA, il faut tout repenser cote auth + isolation des streams + isolation IndexedDB. Risque sous-estime au premier abord.

6. **Le `loop_interval_seconds` est applique strictement par `setInterval`** : si une iteration prend plus de temps que l'interval, ca cree un drift et un backlog (`isExecuting` skip evite le pile-up, mais on perd des events). Pour BoxIA ce serait acceptable car Qwen3 14b est lent ; mais Observer compte sur des modeles 2-7 b qui repondent en < 5 s.

7. **`change_detector` global state** : `previousIterationData` est un `Map<agentId, ...>` global au module. Si on reload l'app, on perd la baseline et la premiere iteration declenche tout. Acceptable pour Observer (mono-user) mais incompatible avec un serveur stateless multi-user. Refactorer si on porte.

## Top-3 preconisations BoxIA

### 1. Creer un module `aibox-watcher` qui apporte la boucle d'automation passive (high impact)

**Quoi** : un nouveau service Next.js sidecar (ou un nouveau type d'agent dans n8n) qui implemente le pattern Observer : "demarre, capture le declencheur (cron / fichier / mail), execute le LLM, reagit". Fonctionnalites a porter :
- `loop_interval_seconds` + `change_detector` (Levenshtein + dHash) avant l'appel LLM
- Sensors generaux pour BoxIA : `$EMAIL_INBOX_NEW`, `$ODOO_INVOICES_DUE`, `$N8N_TRIGGER`, `$DIFY_AGENT@<id>` (cross-agent memoire), `$RAG@<kb_id>`
- Pattern `pause()` / `wake()` / `startAgent()` cote API.

**Pourquoi** : aujourd'hui un client BoxIA a un Concierge interactif et n8n pour des workflows preconfigures, mais **rien** pour de la surveillance continue type "scrute la boite mail + alerte le commercial quand un client mecontent ecrit". Observer prouve que ce loop pattern + change detection + cross-agent memoire est la primitive qui debloque ces use cases. Roadmap : 1 sprint pour le MVP.

**Localisation cible** : `services/app/src/lib/watcher/` + table `aibox_watcher_agents` Postgres + UI `services/app/src/app/watchers/` + tools/migrations versionnees.

### 2. Adopter le pattern "code + system_prompt" couple dans la marketplace BoxIA (medium impact, low cost)

**Quoi** : enrichir `marketplace_dify_fr` pour porter, en plus du `system_prompt`, un bloc `post_processing_code` JS optionnel qui s'execute apres la reponse Dify. Sandbox `new Function()` avec un contexte limite (`response`, `setMemory`, `notify`, `triggerWorkflow(n8nId)`, `sendEmail` via cred boxia). Ainsi un agent Dify peut "decider" de declencher un workflow n8n avec une seule template marketplace.

**Pourquoi** : aujourd'hui Dify ne sait pas trigger n8n proprement (il faut passer par Custom Tool HTTP, fragile). Observer prouve qu'un mini-handler JS post-LLM est l'abstraction parfaite pour brancher des actions sans complexite. Code reutilisable des handlers Observer (utils.ts ~600 lignes).

**Localisation cible** : extension du loader marketplace + handler JS execute dans un worker Node isole cote `services/app`.

### 3. Voler le `code_sanitizer` pour le pre-publish des templates marketplace (small but critical)

**Quoi** : porter `app/src/utils/code_sanitizer.ts` (60 lignes) en TypeScript dans `services/app/src/lib/marketplace/sanitizer.ts`. Avant qu'un user / dev ne push un template Dify ou n8n vers le repo marketplace, scanner :
- emails / phones / IBAN / cles API hardcodees (regex PII FR existantes deja chez nous)
- webhooks Discord/Slack
- tokens GitHub
Bloquer la PR / la commande `tools/marketplace-publish.sh` si detection, suggerer remplacement par placeholder.

**Pourquoi** : on a deja eu un cas (workflow n8n marketplace avec une URL Cloudflare interne hardcodee). Cout du fix : 2h. Eviter un leak de creds dans un template public = priceless.

**Localisation cible** : `services/app/src/lib/marketplace/sanitizer.ts` + integration dans le hook git pre-push + CI GitHub Actions.

---

## Annexe : chemins de reference Observer AI

| Fonctionnalite | Fichier |
|---|---|
| Boucle agent | `app/src/utils/main_loop.ts` |
| Pre-processor sensors | `app/src/utils/pre-processor.ts` |
| Post-processor code exec | `app/src/utils/post-processor.ts` + `handlers/javascript.ts` + `handlers/python.ts` |
| Change detection | `app/src/utils/change_detector.ts` |
| Stream manager (refcount) | `app/src/utils/streamManager.ts` |
| Recording | `app/src/utils/recordingManager.ts` + `recordingsDB.ts` |
| Whisper browser | `app/src/utils/whisper/` |
| OCR Tesseract | `app/src/utils/screenOCR.ts` |
| Sensors map | `app/src/utils/sensorMapping.ts` |
| Marketplace API | `api/marketplace.py` |
| Compute proxy | `api/compute.py` + `api/*_handler.py` |
| Multi-agent creator IA | `app/src/utils/multi_agent_creator.ts` + `components/AICreator/MultiAgentCreator.tsx` |
| Templates simple agent | `app/src/utils/agentTemplateManager.ts` |
| Code sanitizer (PII) | `app/src/utils/code_sanitizer.ts` |
| Tauri desktop | `app/desktop/` |
| Docker compose deprecated | `docker/docker-compose.yml` |

## Annexe : chemins BoxIA references

| Sujet | Localisation |
|---|---|
| Concierge | `services/app/src/components/Chat.tsx` + agent Dify provisionne |
| Marketplace Dify FR | `services/marketplace/dify-fr/` + migrations 001x |
| Marketplace n8n | `services/marketplace/n8n/` |
| Vision | `services/app/src/lib/agents.ts` + `services/inference/` qwen2.5vl |
| OAuth | `services/app/src/app/api/oauth/*` + `lib/oauth-*.ts` |
| Migrations | `tools/migrations/` |
| memoire mem0 | `services/memory/` |
