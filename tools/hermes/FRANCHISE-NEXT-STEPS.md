# AI Box franchise via Hermes — actions utilisateur requises

Suite à la décision **2026-05-13** de pivoter vers une franchise multi-tenant basée sur Hermes Agent (cf. [ARCHITECTURE.md](ARCHITECTURE.md)).

Le squelette pipeline P0/P1 est en place ([provision-hermes-client.sh](../provision-hermes-client.sh), [register-telegram-bot.sh](../register-telegram-bot.sh), [skills/boxia-tools/](skills/boxia-tools/SKILL.md)). **Deux actions utilisateur** sont nécessaires pour activer le premier client de bout en bout.

## Action 1 — Choisir et obtenir une clé LLM cloud (pour la latence <3 s)

L'instance Hermes actuelle tourne en local sur `qwen3:14b-64k` avec une latence de 24-48 s. C'est inacceptable pour un canal de messagerie type Telegram. **Une clé cloud est requise** pour le mode hybride.

### Choix recommandés (par ordre)

| Provider | Modèle | Latence | Coût ~/jour/client (500 msgs) | BYOK possible ? |
|---|---|---|---|---|
| **Anthropic** (recommandé) | Claude Haiku 4.5 | 1-2 s | ~0.10 € | oui |
| **Google Gemini** | Gemini 2.5 Flash | 0.5-1.5 s | ~0.05 € | oui |
| **OpenRouter** | claude-haiku-4.5 (passthrough) | 1-2 s | ~0.12 € | oui |
| **OpenAI** | gpt-4o-mini | 1-2 s | ~0.15 € | oui |

### Comment obtenir la clé

- **Anthropic** : https://console.anthropic.com/settings/keys (créer une clé "API key")
- **Gemini** : https://aistudio.google.com/app/apikey (créer une clé)
- **OpenRouter** : https://openrouter.ai/keys (1 clé = accès tous les modèles)

### Modèles BYOK existant côté BoxIA

`memory/sprint_standard_2026.md` mentionne que BoxIA a déjà un système "Cloud Providers BYOK" (carte `/settings` OpenAI/Anthropic/Mistral, push clé chiffrée à Dify). Si tu as déjà une clé stockée là, tu peux **réutiliser la même** pour Hermes (la clé n'est pas exclusive à un service).

### Une fois la clé obtenue

Pour activer le mode hybride sur l'instance Hermes existante :

```bash
# 1. SSH sur xefia
ssh clikinfo@192.168.15.210

# 2. Ajouter la clé au .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> /srv/xefia/hermes/.env

# 3. Reconfigurer Hermes vers Anthropic primary + fallback local
HERMES_BIN='/opt/hermes/.venv/bin/hermes'
docker exec hermes $HERMES_BIN config set model.provider anthropic
docker exec hermes $HERMES_BIN config set model.default claude-haiku-4-5-20251001
docker exec hermes $HERMES_BIN fallback add custom qwen3:14b-64k --base-url http://ollama:11434/v1 --priority 2

# 4. Restart
docker compose -f /srv/xefia/hermes/docker-compose.yml restart
```

Ou plus simple, pour les futurs tenants : utiliser `tools/provision-hermes-client.sh` qui le fait automatiquement.

## Action 2 — Créer un bot Telegram pour le premier client

Telegram ne permet pas de créer un bot en API (sécurité). Il faut passer par **@BotFather** dans l'app Telegram.

### Procédure (5 minutes)

1. Ouvre **Telegram** (mobile ou desktop)
2. Cherche `@BotFather` dans la barre de recherche, démarre la conversation
3. Envoie `/newbot`
4. Choisis un **nom** : ex. "AI Box Boulangerie Martin"
5. Choisis un **username** terminant en `bot` : ex. `aibox_martin_bot`
6. BotFather te renvoie un **token** du format `8076254842:AAHXxxxxxxxxxxxx`
7. **Copie ce token** (à utiliser à l'étape suivante)
8. *(optionnel mais recommandé)* — Personnalise via BotFather :
   - `/setdescription` → "Votre assistant IA disponible 24/7..."
   - `/setabouttext` → courte présentation
   - `/setuserpic` → upload un logo

### Récupérer ton chat_id (pour t'autoriser comme premier user)

1. Ouvre une conversation avec **ton nouveau bot** sur Telegram
2. Envoie n'importe quel message (ex. "/start")
3. Note ton chat_id : il sera affiché à l'étape suivante par le script `register-telegram-bot.sh`

### Activer le bot côté Hermes

Une fois token + chat_id récupérés :

```bash
# Depuis le worktree BoxIA local
tools/register-telegram-bot.sh "8076254842:AAHXxxx..."
# → le script te listera les chat_id qui ont parlé au bot
# → tu sélectionnes les chat_id à whitelist
# → le script update .env, restart Hermes, envoie un message test
```

Ou pour un tenant spécifique :
```bash
tools/register-telegram-bot.sh "<token>" boulangerie-martin
```

## Premier déploiement client complet (workflow)

Une fois les 2 actions ci-dessus faites, créer le premier client est une commande :

```bash
# Variables pré-remplies via env (sinon le script prompt)
export TELEGRAM_BOT_TOKEN="8076254842:..."
export TELEGRAM_ALLOWED_USERS="123456789"
export CLOUD_PROVIDER="anthropic"
export CLOUD_API_KEY="sk-ant-..."
export BOXIA_AGENT_KEY="$(openssl rand -hex 32)"  # à conserver pour aibox-app

tools/provision-hermes-client.sh boulangerie-martin
```

Résultat :
- Container `hermes-boulangerie-martin` up healthy
- Bot Telegram fonctionnel
- Latence < 3 s
- Fallback `qwen3:14b-64k` si Anthropic indisponible
- Dashboard sur un port unique (allocation automatique 9120+)
- Volume isolé `/srv/xefia/hermes_boulangerie-martin/data/`

**Limite actuelle** : le skill `boxia-tools` est un squelette en attente des endpoints `/api/agent/*` côté `aibox-app` (cf. ARCHITECTURE.md §3 I1). Tant qu'il n'est pas codé, Hermes peut parler au client mais pas créer de facture Pennylane ou autre action métier — il n'a accès qu'à ses 87 skills natifs (web search, kanban, image gen, etc.).

## Roadmap d'ici à un produit franchisable

Cf. [ARCHITECTURE.md §4 Roadmap](ARCHITECTURE.md#4-roadmap-rappel) — 3-4 semaines pour MVP démontrable, 2-3 mois pour produit stable.
