# OpenClaw — Analyse pour BoxIA

## 🪪 Fiche d'identité

**Identité confirmée — c'est bien le projet IA, pas le remake du jeu Captain Claw.**

- **Nom officiel** : OpenClaw (anciennement Warelay → Clawdbot → Moltbot, voir [`VISION.md:13`](.research-cache/openclaw/VISION.md))
- **Nature** : assistant IA personnel local-first qui parle sur les canaux que tu utilises déjà (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, etc. — 24+ canaux). Le composant central s'appelle le **Gateway** : c'est un daemon WebSocket Node.js qui orchestre canaux + sessions + tools + events. Le tagline : *"the AI that actually does things"*.
- **Auteur principal** : Peter Steinberger (steipete, ex-PSPDFKit). Construit autour d'une mascotte/persona "Molty the space lobster". Slogan dans le README : *"EXFOLIATE! EXFOLIATE!"*.
- **Repo** : `github.com/openclaw/openclaw` — TypeScript ESM strict, monorepo pnpm workspace. Node 24 recommandé (22.14+ min).
- **Licence** : MIT (`LICENSE`). Sponsors **massifs** affichés au README : OpenAI, GitHub, NVIDIA, Vercel, Blacksmith, Convex.
- **Activité** : extrêmement intense. Le `CHANGELOG.md` fait **1,9 Mo** (oui, mégaoctet). Discord public `discord.gg/clawd`. Releases en 3 canaux npm : `latest` / `beta` / `dev`.
- **Public cible** : *single-user* assistant — assumé dans le README ("personal, single-user"). Pas multi-tenant. SECURITY.md précise : *"local-first agent infrastructure for trusted operators; not designed as a shared multi-tenant boundary"*.
- **Écosystème ~52 repos** : organisé autour de
  - **`openclaw/openclaw`** — gateway core + 131 plugins bundlés sous `extensions/`
  - **`openclaw/clawhub`** — la **plugin store/marketplace** officielle ([clawhub.ai](https://clawhub.ai)), où sont publiés les plugins externes, skills, MCP servers
  - **`openclaw/nix-openclaw`** — packaging Nix
  - **`openclaw/trust`** — modèle de sécurité/menace public
  - **`openclaw.ai` (sibling)** — installeurs (mentionné dans `AGENTS.md:22`)
  - **`crabbox`** — runner de scenarios live cross-OS (`.crabbox.yaml` à la racine)
  - **`clownfish`** — non exploré ici
  - apps natives **macOS / iOS / Android** (sous `apps/`)
- **DeepWiki** disponible : `deepwiki.com/openclaw/openclaw`.

## 🏗️ Architecture

### Le Gateway, control plane unique

Un seul daemon long-lived (WebSocket sur `127.0.0.1:18789` par défaut) tient tout :
- toutes les connexions canaux (Baileys WhatsApp, grammY Telegram, Slack/Discord SDK, etc.)
- la sessions store (JSONL par session sous `~/.openclaw/agents/<id>/sessions/`)
- l'agent runtime (basé sur **`pi-agent-core`** de Mario Zechner — pas leur stack maison)
- un canvas host HTTP servant `/__openclaw__/canvas/` + `/__openclaw__/a2ui/` (live UI agent-éditable)
- le bridge port 18790 pour l'IPC

Tout client (CLI, app macOS, web, nodes iOS/Android) parle au Gateway via le même WebSocket protocol typé (TypeBox → JSON Schema → Swift codegen). Voir `docs/concepts/architecture.md`.

### Système de plugins à 4 couches

`docs/plugins/architecture.md` décrit 4 layers :
1. **Manifest discovery** — chaque plugin a `openclaw.plugin.json` à la racine, validé **sans exécuter le code**
2. **Enablement + validation** — décide si on l'active, le bloque, ou si c'est l'élu d'un slot exclusif (mémoire = un seul plugin actif)
3. **Runtime loading** — in-process via `require`, fallback Jiti pour TS local
4. **Surface consumption** — registry central que le reste du core lit pour exposer tools/channels/CLI/HTTP

**Capabilities typées** (vs hooks legacy) : `registerProvider`, `registerChannel`, `registerSpeechProvider`, `registerImageGenerationProvider`, `registerWebFetchProvider`, `registerMediaUnderstandingProvider`, etc. (~13 catégories). Chaque plugin déclare ses *shapes* : `plain-capability`, `hybrid-capability`, `hook-only` (legacy), `non-capability`.

### `extensions/` : 131 répertoires

Catalogue impressionnant (`ls extensions/` → 131 entrées). Catégories :
- **Providers LLM** : openai, anthropic, anthropic-vertex, google, mistral, ollama, lmstudio, vllm, sglang, deepseek, qwen, kimi, moonshot, zai, groq, cerebras, cloudflare-ai-gateway, fireworks, together, openrouter, vercel-ai-gateway, litellm… (≥30 providers)
- **Channels** : whatsapp, telegram, slack, discord, signal, imessage, bluebubbles, msteams, matrix, line, feishu, googlechat, mattermost, irc, nostr, twitch, zalo, qqbot, synology-chat, nextcloud-talk, tlon, voice-call…
- **Tools** : browser, firecrawl, brave, exa, tavily, perplexity, duckduckgo, document-extract, image-generation-core, comfy, fal, runway…
- **Voice/TTS** : elevenlabs, deepgram, azure-speech, inworld, talk-voice, senseaudio
- **Mémoire** : active-memory, memory-core, memory-lancedb, memory-wiki (avec contrainte *"un seul plugin mémoire actif à la fois"*)
- **Sandbox** : openshell

### `skills/` : 54 skills bundlés au format AgentSkills

Skills compatibles **[agentskills.io](https://agentskills.io)** = standard ouvert. Chaque skill = dossier avec `SKILL.md` (frontmatter YAML + instructions Markdown) + scripts/ressources optionnels. Précédence à 6 niveaux (`docs/tools/skills.md`):
1. Workspace (`<ws>/skills`)
2. Project agent (`<ws>/.agents/skills`)
3. Personal agent (`~/.agents/skills`)
4. Managed (`~/.openclaw/skills`)
5. Bundled (livré)
6. Extra dirs

Exemples bundlés : `1password`, `apple-notes`, `apple-reminders`, `notion`, `obsidian`, `github`, `slack`, `gh-issues`, `weather`, `taskflow-inbox-triage`, `peekaboo`, `nano-pdf`, `voice-call`, `skill-creator` (un skill qui crée des skills), `summarize`, `things-mac`, `tmux`, `trello`, `xurl`…

### Workspace agent (la "mémoire vive" du persona)

Sous `~/.openclaw/workspace/`, fichiers conventionnels injectés dans le system prompt à chaque session (`docs/concepts/agent-workspace.md`) :
- `AGENTS.md` — instructions opérationnelles
- **`SOUL.md`** — persona, ton, humour, brièveté, opinions (voir le guide dédié `docs/concepts/soul.md` — une vraie philosophie produit : *"short beats long, sharp beats vague"*)
- `USER.md` — qui est l'utilisateur
- `IDENTITY.md` — nom/vibe/emoji du persona
- `TOOLS.md` — conventions tool perso (juste guidance, ne contrôle pas la dispo)
- `BOOTSTRAP.md` — rituel one-shot first-run, supprimé après
- `HEARTBEAT.md` — checklist heartbeat optionnel

### Multi-agent routing dans 1 Gateway

Plusieurs personas isolés (`coding`, `social`, `work`…) avec **leur propre workspace + auth profiles + sessions store**, dans le même daemon. Bindings : un compte canal (un Slack workspace, un Telegram bot) → un agent. `~/.openclaw/agents/<id>/agent/auth-profiles.json` = isolation auth.

### Sandboxing optionnel et fin-grain

`docs/gateway/sandboxing.md` : exécution tools dans un sandbox **Docker** (default), **SSH** (offload sur machine distante), ou **OpenShell** (sandbox managé). Modes : `off` / `non-main` (sandboxe les sessions group/channel mais pas DM main) / `all`. Scope : `agent` / `session` / `shared`. Browser sandbox isolé sur réseau Docker dédié `openclaw-sandbox-browser` avec CDP allowlist CIDR.

### Hooks lifecycle plugin

Surface large (`docs/concepts/agent-loop.md`) : `before_model_resolve`, `before_prompt_build`, `before_agent_reply`, `agent_end`, `before_compaction`, `before_tool_call`/`after_tool_call`, `before_install`, `tool_result_persist`, `message_received`/`sending`/`sent`, `session_start`/`end`, `gateway_start`/`stop`. Sémantique terminale précise : `{block:true}` arrête les handlers de plus basse priorité.

### Stack technique

- **TypeScript ESM strict**, no `any`, `tsgo` (pas `tsc`), formatter **`oxfmt`** (pas Prettier), linter **`oxlint`**
- pnpm workspace, Bun aligned, patches sous `patches/`
- **TypeBox** pour les schémas du protocole + JSON Schema + codegen Swift
- Vitest, **`crabbox`** (linux/win/mac workers) pour scenarios live, Blacksmith Testbox pour les broad gates
- Docker multi-stage, images base pinées par SHA256 digest, dependabot maintient les digests
- OpenTelemetry + Prometheus exposés en built-in
- Cron jobs, webhooks, Gmail Pub/Sub built-in pour automation

## ⭐ Features remarquables

1. **Plugin manifest validable sans exécuter le code** — `openclaw.plugin.json` permet validation config + UI hints sans booter le runtime. C'est un design discipliné, exactement ce qui manque à beaucoup de marketplaces.
2. **AgentSkills standard ouvert** — au lieu d'inventer un format proprio, ils consomment `agentskills.io`. Compatible aussi avec Codex bundles, Claude bundles, Cursor bundles auto-détectés (`docs/plugins/manifest.md:19`).
3. **SOUL.md / AGENTS.md / USER.md / IDENTITY.md** comme contrat de persona versionnable et editable par l'utilisateur (`docs/concepts/soul.md`). Un cadre **opinionated** sur "comment écrire le prompt système d'un assistant qui ne sonne pas corporate".
4. **Session write lock file-based** non-réentrant (`session.writeLock.acquireTimeoutMs` par défaut 60 s, opt-in `allowReentrant`). Process-aware → catche les writers cross-process. Solution propre au problème de transcript races.
5. **Approval gates / DM pairing** — pairing code par défaut sur tout DM externe (Telegram/WhatsApp/Slack…). `dmPolicy="pairing"` produit un short pairing code que l'opérateur valide via `openclaw pairing approve`. Excellent contre le spam et l'injection.
6. **Sandboxed browser** avec CDP source CIDR allowlist, network Docker dédié, noVNC token éphémère via fragment URL (pas query/header logs).
7. **Multi-agent un seul daemon** — agents *isolated* (workspace + auth + sessions) routés via bindings canal→agent, sans devoir lancer N processus.
8. **Skill Workshop plugin** — un plugin qui crée/met à jour des skills à partir des procédures observées en runtime. Quarantaine pour propositions unsafe, hot reload sans restart Gateway.
9. **3 canaux release npm** stable / beta / dev avec switch CLI (`openclaw update --channel stable|beta|dev`).
10. **Doctor exhaustif** (`openclaw doctor`) qui surface DM policy risquées, plugin compatibility advisory, workspace dupliqué, et compatibility signals (`config valid`, `compatibility advisory`, `legacy warning`, `hard error`).
11. **Live Canvas + A2UI** — l'agent peut générer une UI HTML/CSS/JS rendue live dans une fenêtre macOS dédiée, contrôlable par voix (Voice Wake) ou touch (iOS/Android nodes).
12. **Codex/Claude/Cursor bundle compat** — auto-détection de `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`. Joue collectif au lieu de réinventer.

## 🆚 Comparatif avec BoxIA

| Dimension | OpenClaw | BoxIA | Verdict |
|---|---|---|---|
| **Public cible** | Single user (power user, dev) | TPE/PME (multi-user, métier) | **Différents marchés** — pas de concurrence directe |
| **Surface** | Inbox unifié sur 24+ canaux messageries | UI web unifiée `aibox-app` (Next.js) | OpenClaw "vit dans tes apps", BoxIA est l'app |
| **Control plane** | 1 daemon Gateway WebSocket | 33 containers Docker orchestrés | OpenClaw 10× plus léger ops-wise |
| **Plugin model** | 131 plugins, manifest sans exec, 13 capabilities typées | Marketplaces n8n+Dify+MCP curées, pas de manifest plugin propre | **OpenClaw a 5 ans d'avance** sur le contrat plugin |
| **Skills format** | AgentSkills standard ouvert (54 bundlés) | Pas d'équivalent direct, prompts dans Dify | **À piquer** : adopter le standard |
| **Persona contract** | SOUL.md / AGENTS.md / IDENTITY.md / USER.md versionnables | Prompts Dify dans la base, pas de fichier user-editable | **Faiblesse BoxIA** — UX persona à reprendre |
| **Multi-agent** | N agents isolated, bindings canal→agent, 1 daemon | 6 agents Dify partagent l'instance | OpenClaw plus propre sur l'iso, BoxIA OK pour son scope |
| **Sandbox tools** | Docker/SSH/OpenShell, scope `agent`/`session`/`shared`, browser CDP CIDR | Pas de sandbox tools agent (exec sur host Dify) | **Gros gap sécu** côté BoxIA si tools custom |
| **Approval gate** | `dmPolicy="pairing"`, codes pairing par DM | Approval gate Concierge (`/api/concierge/decide`) sur tools mutatifs | Concept identique — BoxIA OK |
| **PII/sécurité** | Pas de scrub PII built-in (single user, trusted) | PII scrub FR (7 patterns), audit log, plafond €/mois cloud | **BoxIA mieux** sur l'usage métier |
| **Self-update** | npm `update --channel`, OTA via npm | Watcher systemd + git pull docker exec | **OpenClaw plus simple** (npm), BoxIA fait du sur-mesure |
| **Stack langage** | TypeScript ESM strict (oxfmt/oxlint/tsgo) | TypeScript Next.js 15 + Python (migrations, scripts) | OpenClaw pure TS, plus discipliné |
| **Docs** | Énorme (`docs.openclaw.ai`), changelog 1,9 Mo, AGENTS.md scoped par dossier | `memory/` interne + CLAUDE.md, peu doc-as-product | **OpenClaw modèle** pour la doc dev |
| **Onboarding** | `openclaw onboard --install-daemon` (CLI guidée) | Wizard web post-install | Approches différentes, les deux valides |
| **Voice/Canvas** | Voice Wake macOS/iOS, Live Canvas A2UI | Pas de voice/canvas live | Pas pertinent court-terme |
| **Mémoire** | Slot exclusif (1 plugin actif): builtin / lancedb / wiki | mem0 sidecar (un seul) | Concept identique |
| **MCP** | Server + runtime integration (`docs/cli/mcp.md`) | Marketplace MCP (15 servers curés) | Stratégies opposées : OpenClaw consomme, BoxIA promeut |

## 🟢 À voler tel quel

1. **Format AgentSkills** — adopter le standard `SKILL.md` + frontmatter YAML pour exposer les "compétences" des agents BoxIA. C'est ce que Codex/Claude/Cursor utilisent déjà → interop gratuite avec leurs marketplaces (`docs/plugins/bundles.md`). Action concrète : `tools/migrations/00XX_skills_format.py` qui scanne les apps Dify et exporte un `SKILL.md` par agent.
2. **Manifest plugin séparé du code** — chaque marketplace entry (n8n / Dify / MCP) devrait avoir un `boxia.plugin.json` à côté du compose/JSON métier, validé schéma sans exécuter. Aligne `services/app/src/lib/dify-marketplace.ts` + `services/app/src/lib/boxia-fr-templates.ts`.
3. **DM pairing par défaut** quand BoxIA branchera des canaux externes (Slack/Teams en lecture/notif) → reprendre `pairing approve <channel> <code>` (`README.md:140`). Pas urgent mais à archiver pour le sprint canaux.
4. **`openclaw doctor`-style command** — un `aibox doctor` qui sort un rapport coloré : containers up, migrations pending, DB drift, agent prompts non standards, providers cloud sans clé valide, RBAC orphelin. BoxIA a déjà des bouts (`smoke test` dans deploy-to-xefia.sh) mais pas un doctor consolidé visible côté UI.
5. **Compatibility signals** (`config valid` / `compatibility advisory` / `legacy warning` / `hard error`) à afficher côté UI Marketplace BoxIA pour les workflows n8n et apps Dify dépréciés.
6. **Session write lock file-based** non-réentrant — utile pour `services/app/src/lib/conversations.ts` si on commence à voir des races multi-tab côté utilisateur. Pattern propre, copiable.

## 🟡 À adapter

1. **SOUL.md / AGENTS.md / IDENTITY.md / USER.md / TOOLS.md** — l'idée de fichiers user-editable versionnables qui composent le system prompt. Pour BoxIA → table SQL `agent_persona_files` + UI `/Discuter > Configurer agent` avec onglets "Persona / Instructions / Utilisateur / Tools" qui éditent ces blocs Markdown. Aujourd'hui le prompt système est noyé dans Dify, peu accessible. Cette UX est **directement applicable** à `services/app/src/app/agents/[slug]/configure/page.tsx`.
2. **Capability model typé** (`registerProvider`, `registerChannel`, `registerWebFetchProvider`…) — au lieu d'avoir 1 type "marketplace entry" fourre-tout côté BoxIA, typer la registration : `dify.registerAgent`, `n8n.registerWorkflow`, `mcp.registerTool`, `dify.registerKnowledge`, `cloud.registerProvider`. Affecte `services/app/src/lib/dify-marketplace.ts` et `services/app/src/lib/n8n-marketplace.ts`.
3. **Sandboxing tools custom** — quand BoxIA permettra des Custom Tools script perso (au-delà des connecteurs OAuth typés), il faudra une isolation. Modèle Docker scope `agent` est le bon défaut. Voir `services/app/src/lib/connector-tool-helpers.ts`.
4. **Cron jobs / webhooks first-class** — OpenClaw les a built-in (`docs/automation/`). BoxIA délègue à n8n. OK à court terme, mais une couche `boxia.scheduler` qui abstrait sur n8n + cron host éviterait que tout client doive comprendre n8n pour lire un digest.
5. **Doctor command** — déjà cité. Adaptation BoxIA : UI dans `/admin/health` qui exécute le smoke test côté serveur et retourne traffic light + actions cliquables ("Migration 0013 pending → Appliquer", "Provider Mistral sans clé → Renseigner").

## 🔵 À surveiller

1. **Marketplace ClawHub** ([clawhub.ai](https://clawhub.ai)) — modèle de plugin store séparé du repo core, avec "official publisher status, provenance, and security review" (`VISION.md:73`). Si BoxIA grandit en plugins tiers, ce séparation core/store est la trajectoire.
2. **`crabbox`** comme runner E2E cross-OS — pourrait remplacer/compléter notre setup Chrome MCP pour les tests live de BoxIA si on veut couvrir Win/Mac/Linux clients (encore plus pertinent quand on aura un client desktop wrappé Tauri/Electron).
3. **A2UI / Live Canvas** — UI agent-éditable en HTML rendue côté client (`docs/concepts/canvas-host`). Pas pertinent court-terme mais à archiver : permettrait à un agent BoxIA de générer un dashboard custom à la volée pour une question métier ("affiche mes ventes ce mois en barre chart").
4. **TypeBox protocol → JSON Schema → Swift codegen** — pattern intéressant le jour où BoxIA aura une app mobile native ou un SDK client.
5. **`openclaw migrate codex|hermes`** — extensions qui importent les configs d'autres outils. Pour BoxIA, un `aibox migrate openwebui` ou `aibox migrate librechat` serait un argument commercial fort pour clients qui ont déjà tâté l'IA local.
6. **VISION.md "What We Will Not Merge"** (lignes 106-115) — discipline produit explicite : *"agent-hierarchy frameworks (manager-of-managers / nested planner trees) as a default architecture"* est out. Confirme notre choix BoxIA de **rester sur Dify et de ne pas migrer LangGraph/CrewAI**.

## 🔴 Pièges identifiés

1. **OpenClaw n'est PAS multi-tenant** — explicitement écrit dans SECURITY.md : *"not designed as a shared multi-tenant boundary between adversarial users on one gateway"*. Si BoxIA s'inspire trop de leur archi, on hérite de cette limite. **BoxIA EST multi-tenant par conception** (RBAC, audit, PII scrub) → ne pas copier la posture sécu single-user.
2. **Pas de RBAC / multi-user** — un opérateur = full access. Toute notre Phase 1 RBAC connector-by-connector est étrangère à OpenClaw. Ne pas régresser en croyant copier "le bon design".
3. **`network_mode: host` plus sandbox host-side** — OpenClaw recommande Docker DooD avec mapping de paths absolus et avertit explicitement : *"OpenClaw natively throws an EACCES permission error attempting to write its heartbeat inside the container environment because the fully qualified path string doesn't exist natively"* (`docs/gateway/sandboxing.md` warning). Notre `host_mode` côté BoxIA évite déjà ce piège mais c'est un rappel : si on dockérise des sandboxes tools, gérer parité chemin natif/conteneur dès le départ.
4. **TS strict + tsgo + oxfmt + oxlint partout** — discipline coûteuse à imposer rétroactivement à BoxIA si on veut s'aligner. À évaluer en coût/bénéfice (probable : non rentable).
5. **AGENTS.md scoped par sous-dossier** — OpenClaw a un AGENTS.md à la racine + 1 par sous-dossier important (`extensions/AGENTS.md`, `src/channels/AGENTS.md`, etc.). Risque de drift et de conflits de règles. BoxIA fait plus simple avec un `CLAUDE.md` racine + `memory/` indexé. Ne pas adopter le pattern scoped sans rationale clair.
6. **Le changelog 1,9 Mo** — symptôme d'une release cadence très haute (multi-daily). Sans automation, c'est invivable. BoxIA a moins de surface, OK pour rester sur conventional commits + memory courts.
7. **"Plugin code in `extensions/` is internal, but say 'plugin' in product/docs/UI/changelog"** (`AGENTS.md:15`) — faux ami terminologique sur lequel ils sont stricts. Si on copie leur taxonomie, attention au slug/path vs label utilisateur.
8. **`prompt-injection-only` n'est pas un security bug pour eux** — choix défendable pour single-user, **pas tenable pour BoxIA**. Notre PII scrub + approval gate sont la bonne posture.

## 🎯 Top-3 préconisations BoxIA

### 1. Adopter le format AgentSkills + le contrat de fichiers persona (SOUL.md / AGENTS.md / USER.md / IDENTITY.md)

**Pourquoi** : aujourd'hui les prompts agents BoxIA vivent dans la DB Dify, pas user-éditables et pas versionnés. C'est le plus gros gap UX vs OpenClaw. Le format AgentSkills étant standard ouvert ([agentskills.io](https://agentskills.io)) compatible Codex/Claude/Cursor, on gagne interop **gratuite** avec leurs ecosystems.

**Action concrète** :
- Migration `tools/migrations/00XX_skill_files.py` : pour chaque app Dify, exporter le system prompt vers `~/.aibox/agents/<slug>/SOUL.md` + `AGENTS.md`, et synchroniser dans les 2 sens
- UI `services/app/src/app/agents/[slug]/configure/page.tsx` : 4 onglets éditables "Persona / Instructions / Utilisateur / Skills"
- Nouveau endpoint `services/app/src/app/api/agents/[slug]/persona/route.ts` qui lit/écrit ces fichiers + push dans Dify
- Ajouter `services/app/src/lib/skills.ts` qui scanne `~/.aibox/skills/<id>/SKILL.md` et les expose comme tools dans le marketplace

**ROI** : énorme. UX Premium que les clients verront immédiatement, et préparation au moment où on voudra ouvrir un Skills marketplace BoxIA.

### 2. Refondre la marketplace BoxIA autour d'un manifest typé `boxia.plugin.json`

**Pourquoi** : aujourd'hui `dify-marketplace.ts`, `n8n-marketplace.ts`, `boxia-fr-templates.ts`, `mcp` curé… sont 4 systèmes parallèles. OpenClaw montre qu'un manifest unique (validable sans exec, avec capabilities typées) tient les 131 plugins propres. Sans ça, on va se faire dépasser par notre propre catalogue.

**Action concrète** :
- Schéma `services/app/src/lib/plugin-manifest.ts` (zod) avec capabilities typées : `dify-agent`, `dify-knowledge`, `n8n-workflow`, `mcp-server`, `connector-oauth`, `cloud-provider`, `tts-provider`
- Chaque entry marketplace livrée avec son `boxia.plugin.json` validé au load
- UI Marketplace affiche compatibility signals (`config valid` / `legacy warning` / `hard error`) — repris d'OpenClaw `docs/plugins/architecture.md`
- Cloner pattern : `openclaw plugins inspect <id>` → `aibox marketplace inspect <id>`

**ROI** : moyen-fort. Coût ~1 sprint, mais ça paie chaque fois qu'on ajoute un nouveau type marketplace ou qu'un client tiers veut publier.

### 3. Construire un `aibox doctor` consolidé visible côté UI admin

**Pourquoi** : OpenClaw `doctor` est un atout commercial évident — l'opérateur voit en 5 secondes ce qui ne va pas. BoxIA a déjà la matière (smoke test deploy, healthcheck containers, migrations pending) mais c'est dispersé. Un client en démo qui voit "tout est vert" gagne instantanément confiance.

**Action concrète** :
- Endpoint `services/app/src/app/api/admin/doctor/route.ts` qui agrège : containers status (33), migrations pending (`tools/migrations/run-pending.py --check`), DB drift Dify/n8n/Authentik, providers cloud avec clé manquante, RBAC orphelins, agents dont le system prompt diverge des fichiers persona, reverse-DNS demo.ialocal.pro, certs let's encrypt expiry
- Page `services/app/src/app/admin/health/page.tsx` avec liste traffic-light + bouton "Réparer" par item (cliquable seulement si actionable)
- CLI compagnon `tools/aibox-doctor.sh` qui sort le même JSON pour le SSH troubleshooting

**ROI** : élevé pour la perception de robustesse en démo client + accélère grandement le diagnostic en SAV.

---

**Sources clés consultées dans `D:\IA_TPE_PME_POWER\.research-cache\openclaw\`** :
- `README.md`, `VISION.md`, `SECURITY.md`, `AGENTS.md`, `Dockerfile`, `docker-compose.yml`, `.env.example`
- `docs/concepts/architecture.md`, `agent-loop.md`, `agent-workspace.md`, `agent.md`, `multi-agent.md`, `soul.md`
- `docs/plugins/architecture.md`, `manifest.md`
- `docs/gateway/sandboxing.md`
- `docs/tools/skills.md`
- `extensions/ollama/`, `extensions/whatsapp/` (samples plugin layouts)
- `skills/skill-creator/SKILL.md` (sample skill)
- ls listings : `extensions/` (131 plugins), `skills/` (54 skills), `src/`, `apps/`, `docs/`
