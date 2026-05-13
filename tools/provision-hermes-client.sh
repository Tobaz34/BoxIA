#!/usr/bin/env bash
# =============================================================================
# provision-hermes-client.sh
# -----------------------------------------------------------------------------
# Provisionne un nouveau client/tenant Hermes Agent sur xefia.
# 1 client = 1 container Hermes isolé + 1 bot Telegram + 1 volume data dédié.
#
# Usage :
#   tools/provision-hermes-client.sh <tenant_id>
#
#   tenant_id : slug (a-z0-9-) identifiant le client, ex. boulangerie-martin
#
# Variables d'environnement optionnelles (sinon prompted ou auto) :
#   TELEGRAM_BOT_TOKEN     : token du bot @BotFather pour ce client
#   TELEGRAM_ALLOWED_USERS : user_id Telegram du gérant (comma-sep)
#   CLOUD_PROVIDER         : anthropic | openrouter | openai | gemini | none
#   CLOUD_API_KEY          : clé API du provider cloud
#   BOXIA_AGENT_KEY        : shared secret pour l'API server-to-server aibox-app
#   AIBOX_TENANT_ID        : tenant_id côté BoxIA (default = tenant_id Hermes)
#
# Idempotent : peut être rejoué pour un client existant (mise à jour des
# variables sans casser les data).
#
# Crée :
#   /srv/xefia/hermes_<tenant_id>/data/      (volume Hermes, chown 10000)
#   /srv/xefia/hermes_<tenant_id>/compose/   (compose + .env + secrets)
#   container hermes-<tenant_id> sur ollama_net + extra_hosts pour aibox-app
# =============================================================================
set -euo pipefail

# ---- Args -----------------------------------------------------------------
if [ $# -lt 1 ]; then
  sed -n '2,30p' "$0"
  exit 2
fi

TENANT_ID="$1"
case "$TENANT_ID" in
  *[!a-z0-9-]*|"")
    echo "❌ tenant_id invalide : doit matcher [a-z0-9-]+ (ex: boulangerie-martin)" >&2
    exit 2
    ;;
esac

# ---- Config ---------------------------------------------------------------
SSH_HOST="${HERMES_SSH_HOST:-clikinfo@192.168.15.210}"
TENANT_ROOT="/srv/xefia/hermes_${TENANT_ID}"
TENANT_DIR="${TENANT_ROOT}/compose"
TENANT_DATA="${TENANT_ROOT}/data"
CONTAINER="hermes-${TENANT_ID}"
DASHBOARD_PORT_BASE=9120  # port_base + index tenant pour éviter conflits
GATEWAY_PORT_INTERNAL=8642  # toujours interne au container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL_DIR="$SCRIPT_DIR/hermes"
MODEL_DERIVED="qwen3:14b-64k"  # fallback local
NUM_CTX=65536

# Saisie variables manquantes via prompt (TTY) — sinon erreur explicite
prompt_or_env() {
  local var="$1" desc="$2"
  if [ -z "${!var:-}" ]; then
    if [ -t 0 ]; then
      read -r -p "$desc : " value
      printf -v "$var" '%s' "$value"
    else
      echo "❌ Variable $var manquante en mode non-interactif ($desc)" >&2
      exit 2
    fi
  fi
}

# ---- Helpers --------------------------------------------------------------
log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

run_ssh() { ssh -o BatchMode=yes "$SSH_HOST" "$1"; }

# Alloue un port dashboard libre en partant de DASHBOARD_PORT_BASE
allocate_port() {
  local p=$DASHBOARD_PORT_BASE
  while run_ssh "ss -tlnp 2>/dev/null | grep -q ':$p '"; do
    p=$((p+1))
    [ $p -gt 9200 ] && fail "Aucun port libre entre 9120-9200"
  done
  echo "$p"
}

# ---- Pré-flight -----------------------------------------------------------
log "Provisioning tenant : $TENANT_ID"
[ -f "$TPL_DIR/Dockerfile" ] || fail "Templates absents : $TPL_DIR"

# Vérifie pas de conflit si tenant existe déjà
EXISTS=$(run_ssh "test -d '$TENANT_ROOT' && echo YES || echo NO")
if [ "$EXISTS" = "YES" ]; then
  warn "Tenant $TENANT_ID existe déjà — mode update"
fi

# ---- Variables ------------------------------------------------------------
prompt_or_env TELEGRAM_BOT_TOKEN     "Telegram bot token (de @BotFather, format 123456:ABC...)"
prompt_or_env TELEGRAM_ALLOWED_USERS "Telegram chat_id autorisé (entier, ou liste comma-sep)"
prompt_or_env CLOUD_PROVIDER         "Cloud LLM provider (anthropic|openrouter|gemini|openai|none)"
if [ "$CLOUD_PROVIDER" != "none" ]; then
  prompt_or_env CLOUD_API_KEY        "Clé API $CLOUD_PROVIDER"
fi
prompt_or_env BOXIA_AGENT_KEY        "Shared secret aibox-app (pour /api/agent/*)"
AIBOX_TENANT_ID="${AIBOX_TENANT_ID:-$TENANT_ID}"

# ---- 1. Dossiers ----------------------------------------------------------
log "[1/7] Dossiers"
run_ssh "mkdir -p '$TENANT_DIR' '$TENANT_DATA'"
run_ssh "chmod 755 '$TENANT_DIR' 2>/dev/null || true ; chmod 755 '$TENANT_DATA' 2>/dev/null || true"
ok "Dossiers OK"

# ---- 2. Port dashboard ----------------------------------------------------
log "[2/7] Allocation port dashboard"
if [ "$EXISTS" = "YES" ]; then
  # Réutilise le port existant si possible
  DASHBOARD_PORT=$(run_ssh "grep -oE '[0-9]+:9119' '$TENANT_DIR/docker-compose.yml' 2>/dev/null | cut -d: -f1" || echo "")
  [ -z "$DASHBOARD_PORT" ] && DASHBOARD_PORT=$(allocate_port)
else
  DASHBOARD_PORT=$(allocate_port)
fi
ok "Dashboard port : $DASHBOARD_PORT"

# ---- 3. Secrets (préserve si existe, sinon génère API_SERVER_KEY) ----------
log "[3/7] Secrets (.env)"
EXISTING_KEY=$(run_ssh "test -f '$TENANT_DIR/.env' && grep '^API_SERVER_KEY=' '$TENANT_DIR/.env' | cut -d= -f2" || echo "")
if [ -n "$EXISTING_KEY" ]; then
  HERMES_KEY="$EXISTING_KEY"
  ok "API_SERVER_KEY préservée"
else
  HERMES_KEY=$(run_ssh "openssl rand -hex 24")
  ok "API_SERVER_KEY générée"
fi

# Écrit .env
run_ssh "cat > '$TENANT_DIR/.env' <<EOF
# tenant=$TENANT_ID
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=$GATEWAY_PORT_INTERNAL
API_SERVER_KEY=$HERMES_KEY
HERMES_DASHBOARD=1
TZ=Europe/Paris

# Telegram
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USERS=$TELEGRAM_ALLOWED_USERS

# BoxIA bridge (skill boxia-tools)
BOXIA_AGENT_KEY=$BOXIA_AGENT_KEY
BOXIA_TENANT_ID=$AIBOX_TENANT_ID
BOXIA_API_BASE=http://host.docker.internal:3100/api/agent

# Cloud LLM (provider primary)
EOF"

# Ajoute la clé cloud appropriée selon le provider
case "$CLOUD_PROVIDER" in
  anthropic)   run_ssh "echo 'ANTHROPIC_API_KEY=$CLOUD_API_KEY' >> '$TENANT_DIR/.env'" ;;
  openrouter)  run_ssh "echo 'OPENROUTER_API_KEY=$CLOUD_API_KEY' >> '$TENANT_DIR/.env'" ;;
  gemini)      run_ssh "echo 'GOOGLE_API_KEY=$CLOUD_API_KEY' >> '$TENANT_DIR/.env'" ;;
  openai)      run_ssh "echo 'OPENAI_API_KEY=$CLOUD_API_KEY' >> '$TENANT_DIR/.env'" ;;
  none)        warn "Pas de cloud LLM — mode local-only (latence 24-48s)" ;;
  *)           fail "CLOUD_PROVIDER inconnu : $CLOUD_PROVIDER" ;;
esac

run_ssh "chmod 600 '$TENANT_DIR/.env'"
run_ssh "echo '$HERMES_KEY' > '$TENANT_DIR/.api_key' && chmod 600 '$TENANT_DIR/.api_key'"
ok ".env + .api_key OK"

# ---- 4. Compose templated -------------------------------------------------
log "[4/7] docker-compose.yml templated"
run_ssh "cat > '$TENANT_DIR/docker-compose.yml' <<EOF
# Tenant : $TENANT_ID — Hermes Agent franchise IA BOX
services:
  hermes:
    image: aibox-hermes:fr
    build:
      context: $TENANT_DIR
      dockerfile: Dockerfile
    container_name: $CONTAINER
    restart: unless-stopped
    command: gateway run
    env_file:
      - $TENANT_DIR/.env
    environment:
      - HERMES_HOME=/opt/data
    volumes:
      - $TENANT_DATA:/opt/data
    ports:
      - \"$DASHBOARD_PORT:9119\"
    networks:
      - ollama_net
    extra_hosts:
      - \"host.docker.internal:host-gateway\"
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: \"1.0\"
    shm_size: 512m
    healthcheck:
      test: [\"CMD-SHELL\", \"curl -fsS http://localhost:9119/health || exit 1\"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 60s

networks:
  ollama_net:
    external: true
EOF"

# Dockerfile : copie le template aibox-hermes (P2 fournira aibox-hermes:fr,
# en P0.5/P1 on utilise hermes:iabox + python-telegram-bot)
run_ssh "cat > '$TENANT_DIR/Dockerfile' <<'EOF'
FROM nousresearch/hermes-agent:latest
USER root
RUN VIRTUAL_ENV=/opt/hermes/.venv uv pip install --no-cache-dir python-telegram-bot
USER hermes
EOF"
ok "Compose + Dockerfile OK"

# ---- 5. Build + Up --------------------------------------------------------
log "[5/7] Build + Up"
run_ssh "docker compose -f '$TENANT_DIR/docker-compose.yml' up -d --build 2>&1 | tail -3"

# ---- 6. Wait healthy + configure provider ---------------------------------
log "[6/7] Wait healthy + config hybride"
ATTEMPTS=0
while [ $ATTEMPTS -lt 12 ]; do
  HEALTH=$(run_ssh "docker inspect $CONTAINER --format '{{.State.Health.Status}}' 2>/dev/null" || echo missing)
  [ "$HEALTH" = "healthy" ] && break
  sleep 10
  ATTEMPTS=$((ATTEMPTS+1))
done
[ "$HEALTH" = "healthy" ] || fail "Container $CONTAINER pas healthy après 2 min"

# Configure provider primary (cloud) + fallback (local qwen3:14b-64k)
HERMES_BIN='/opt/hermes/.venv/bin/hermes'
case "$CLOUD_PROVIDER" in
  anthropic)
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.provider anthropic"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.default claude-haiku-4-5-20251001"
    ;;
  openrouter)
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.provider openrouter"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.default anthropic/claude-haiku-4.5"
    ;;
  gemini)
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.provider gemini"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.default gemini-2.5-flash"
    ;;
  openai)
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.provider openai"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.default gpt-4o-mini"
    ;;
  none)
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.provider custom"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.base_url http://ollama:11434/v1"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.default $MODEL_DERIVED"
    run_ssh "docker exec $CONTAINER $HERMES_BIN config set model.context_length $NUM_CTX"
    ;;
esac

# Fallback local (utilisé si cloud KO / sensible)
if [ "$CLOUD_PROVIDER" != "none" ]; then
  run_ssh "docker exec $CONTAINER $HERMES_BIN fallback add custom $MODEL_DERIVED --base-url http://ollama:11434/v1 --priority 2 2>&1 | tail -3" || warn "fallback add a échoué (peut-être déjà présent)"
fi

run_ssh "docker compose -f '$TENANT_DIR/docker-compose.yml' restart"
sleep 20
ok "Provider configuré, container restart"

# ---- 7. Validation E2E ----------------------------------------------------
log "[7/7] Test E2E"
RESULT=$(run_ssh "
  docker run --rm --network ollama_net curlimages/curl:latest -s -X POST \
    -H 'Authorization: Bearer $HERMES_KEY' \
    -H 'Content-Type: application/json' \
    'http://$CONTAINER:8642/v1/chat/completions' \
    -d '{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"Dis OK\"}],\"stream\":false,\"max_tokens\":30}'
")
echo "$RESULT" | head -c 400
echo
if echo "$RESULT" | grep -q '"finish_reason"'; then
  ok "Test E2E réussi"
else
  warn "Réponse inattendue — voir docker logs $CONTAINER"
fi

echo ""
ok "==============================================="
ok "  Tenant $TENANT_ID provisionné"
ok "==============================================="
echo ""
echo "  Dashboard       : http://192.168.15.210:$DASHBOARD_PORT"
echo "  Container       : $CONTAINER"
echo "  Bot Telegram    : (token configuré)"
echo "  Data            : $TENANT_DATA"
echo "  Provider primary: $CLOUD_PROVIDER"
echo "  Fallback local  : qwen3:14b-64k via ollama_net"
echo ""
echo "  Pour relancer / mettre à jour : tools/provision-hermes-client.sh $TENANT_ID"
