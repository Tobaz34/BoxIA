# Hermes Agent — intégration IA BOX

Stack standalone Hermes Agent ([nous research](https://hermes-agent.nousresearch.com/), MIT) déployé sur xefia, branché sur Ollama local pour l'inférence.

> ⚠ **Hors scope BoxIA** : Hermes vit dans `/srv/xefia/hermes/` + `/srv/xefia/hermes_data/`, pas dans `/srv/ai-stack/`. Géré hors `tools/deploy-to-xefia.sh`. Cohabite avec la stack BoxIA via le réseau `ollama_net` partagé.

## Déploiement / re-déploiement

Un seul script, idempotent, rejouable à volonté :

```bash
tools/deploy-hermes-to-xefia.sh
```

Le script :

1. Vérifie les pré-requis serveur (`ollama_net`, ports 8642/9119 libres, qwen3:14b présent).
2. Crée le modèle dérivé `qwen3:14b-64k` (Modelfile, `num_ctx 65536`) si absent.
3. Crée les dossiers `/srv/xefia/hermes/` + `/srv/xefia/hermes_data/`.
4. Génère `API_SERVER_KEY` aléatoire **uniquement si `.env` n'existe pas** (preserve la clé entre déploiements).
5. Copie `Dockerfile` + `docker-compose.yml` depuis ce dossier.
6. `docker compose build` (image `hermes:iabox` = officielle + `python-telegram-bot`).
7. `docker compose up -d` puis attend `healthy`.
8. Configure le provider Ollama via `hermes config set` (idempotent).
9. Si `/srv/xefia/openclaw_config/` existe et `hermes_data/migration/openclaw/` est vide → migration automatique.
10. Test E2E /v1/chat/completions.

## Fichiers de ce dossier

| Fichier | Rôle |
|---|---|
| `Dockerfile` | image custom `hermes:iabox` (officielle + `python-telegram-bot`) |
| `docker-compose.yml` | service `hermes` sur `ollama_net`, healthcheck `curl /health` |
| `Modelfile.qwen3-14b-64k` | dérive `qwen3:14b` avec `num_ctx 65536` (Hermes exige ≥64K) |
| `n8n-hermes-chat.json` | workflow n8n exemple (HTTP POST → API gateway) |
| `README.md` | ce fichier |

`tools/deploy-hermes-to-xefia.sh` consomme ces fichiers et fait tout le reste.

## Architecture déployée

- **Container** : `hermes`, image `hermes:iabox`, réseau `ollama_net`
- **Dashboard** : http://192.168.15.210:9119 (publié sur host)
- **API gateway** : `http://hermes:8642` (interne `ollama_net`, jamais sur host)
- **Modèle LLM** : `qwen3:14b-64k` (tool calling natif, FR natif, contexte 64K)
- **Volume data** : `/srv/xefia/hermes_data/` chown `hermes:hermes` (UID 10000) au boot
- **Clé API gateway** : `/srv/xefia/hermes/.api_key` (clikinfo:clikinfo 600)

## Pré-requis serveur

- Ollama running sur `ollama_net` (déjà le cas avec stack BoxIA ou stack_xefia)
- `qwen3:14b` pull dans Ollama (`docker exec ollama ollama pull qwen3:14b`)
- Ports 8642 + 9119 libres
- ≥5 Go disque sur `/srv/xefia/`
- GPU NVIDIA accessible par Ollama (le LLM tourne dans Ollama, pas dans Hermes)

## Connexion Telegram (post-déploiement, action utilisateur)

Le script déploie Hermes sans bot Telegram. Pour activer :

1. Telegram → @BotFather → `/newbot` → noter le token
2. `/start` au bot, puis `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → noter `from.id`
3. Sur xefia :
   ```
   echo "TELEGRAM_BOT_TOKEN=<token>" >> /srv/xefia/hermes/.env
   echo "TELEGRAM_ALLOWED_USERS=<user_id>" >> /srv/xefia/hermes/.env
   docker compose -f /srv/xefia/hermes/docker-compose.yml restart
   ```

## Commandes utiles

```bash
# Santé
docker ps --filter name=hermes
docker logs hermes -f
docker exec hermes /opt/hermes/.venv/bin/hermes doctor
docker exec hermes /opt/hermes/.venv/bin/hermes status
docker exec hermes /opt/hermes/.venv/bin/hermes config show

# Test API
HERMES_KEY=$(cat /srv/xefia/hermes/.api_key)
curl -s -X POST http://192.168.15.210:9119/api/v1/chat \
  -H "Authorization: Bearer $HERMES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:14b-64k","messages":[{"role":"user","content":"ping"}]}'

# Cycle de vie
docker compose -f /srv/xefia/hermes/docker-compose.yml pull   # nouvelle image officielle
docker compose -f /srv/xefia/hermes/docker-compose.yml up -d --build
docker compose -f /srv/xefia/hermes/docker-compose.yml restart

# Backup data (avant un reset xefia)
sudo tar czf /tmp/hermes_data_$(date +%F).tar.gz /srv/xefia/hermes_data/
```

## Limitations connues

- **Latence ~24–48 s/réponse** : le modèle qwen3:14b avec `num_ctx 65536` pèse 17 GB → split GPU 69 % / CPU 31 % (VRAM 12 Go RTX 4070 Super). Pistes : Q3 quant, ou `qwen2.5:14b` (128K natif, plus pertinent au-delà de 40K tokens cumulés).
- **`num_ctx 65536 > native 40960`** : qualité légèrement dégradée au-delà de 40K tokens cumulés (RoPE extrapolation). OK pour usage agent standard.
- **Pas de métriques Prometheus natives** chez Hermes (l'endpoint `/metrics` sert le SPA dashboard). Monitoring via `docker logs hermes` + healthcheck.
