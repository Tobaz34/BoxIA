#!/usr/bin/env bash
# =============================================================================
# update-service-version.sh
# -----------------------------------------------------------------------------
# Met à jour la version d'un service tiers (Dify, Qdrant, Authentik, n8n,
# Ollama, Langfuse) avec rollback automatique en cas d'échec du smoke test.
#
# Usage : update-service-version.sh <slug> <target_version>
#
# Mécanique :
#   1. Backup /srv/ai-stack/.env vers .env.svcupdate-backup
#   2. Patch la variable VERSION dans .env (ex: DIFY_VERSION=1.14.0)
#   3. docker compose pull + up -d --force-recreate sur le compose ciblé
#   4. Smoke test : curl healthcheck (timeout 90s)
#   5. Si KO → restaure .env.svcupdate-backup + recreate avec ancienne version
#
# Logs sur stdout (capturés par le watcher dans /home/clikinfo/.aibox-svcupdate.log).
# =============================================================================
set -euo pipefail

REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
ENV_FILE="$REPO/.env"
ENV_BACKUP="$REPO/.env.svcupdate-backup"

SLUG="${1:?Usage: $0 <slug> <target_version>}"
TARGET="${2:?Usage: $0 <slug> <target_version>}"

log() { printf '%s [svcupdate] %s\n' "$(date -Iseconds)" "$*"; }

# Validation : target ne contient que des chars safe (no shell injection)
if ! [[ "$TARGET" =~ ^[v]?[0-9A-Za-z._\-]+$ ]]; then
  log "✗ target_version invalide : $TARGET"
  exit 2
fi

# -----------------------------------------------------------------------------
# Mapping slug → (env_var, compose_dir, service_name, health_url)
# -----------------------------------------------------------------------------
case "$SLUG" in
  dify)
    ENV_VAR="DIFY_VERSION"
    COMPOSE_DIR="$REPO/services/dify"
    SERVICE="dify-api"
    HEALTH_URL="http://localhost:8081/console/api/setup"
    HEALTH_OK_CODES="200"
    ;;
  qdrant)
    ENV_VAR="QDRANT_VERSION"
    COMPOSE_DIR="$REPO"
    SERVICE="qdrant"
    HEALTH_URL="http://localhost:6333/healthz"
    HEALTH_OK_CODES="200"
    ;;
  authentik)
    ENV_VAR="AUTHENTIK_VERSION"
    COMPOSE_DIR="$REPO/services/authentik"
    SERVICE="authentik-server"
    HEALTH_URL="http://localhost:9000/-/health/live/"
    HEALTH_OK_CODES="200,204"
    ;;
  n8n)
    ENV_VAR="N8N_VERSION"
    COMPOSE_DIR="$REPO/services/n8n"
    SERVICE="n8n"
    HEALTH_URL="http://localhost:5678/healthz"
    HEALTH_OK_CODES="200"
    ;;
  ollama)
    ENV_VAR="OLLAMA_VERSION"
    COMPOSE_DIR="$REPO/services/inference"
    SERVICE="ollama"
    HEALTH_URL="http://localhost:11434/api/version"
    HEALTH_OK_CODES="200"
    ;;
  langfuse)
    ENV_VAR="LANGFUSE_VERSION"
    COMPOSE_DIR="$REPO/services/observability"
    SERVICE="langfuse-web"
    HEALTH_URL="http://localhost:3001/api/public/health"
    HEALTH_OK_CODES="200"
    ;;
  *)
    log "✗ slug inconnu : $SLUG (supportés : dify, qdrant, authentik, n8n, ollama, langfuse)"
    exit 2
    ;;
esac

if [[ ! -d "$COMPOSE_DIR" ]]; then
  log "✗ compose dir absent : $COMPOSE_DIR"
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  log "✗ .env absent : $ENV_FILE"
  exit 2
fi

CURRENT=$(grep -E "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//' || echo "")
log "service=$SLUG var=$ENV_VAR current=$CURRENT target=$TARGET"
if [[ "$CURRENT" == "$TARGET" ]]; then
  log "✓ déjà à $TARGET — no-op"
  exit 0
fi

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
patch_env_var() {
  # Modifie ou ajoute la ligne ${ENV_VAR}=value dans .env (idempotent).
  # Utilise un fichier temporaire + mv atomique (pas de risque de fichier vide).
  local var="$1" value="$2" file="$3"
  if grep -qE "^${var}=" "$file"; then
    sed -i.tmp "s|^${var}=.*|${var}=${value}|" "$file" && rm -f "${file}.tmp"
  else
    printf '\n%s=%s\n' "$var" "$value" >> "$file"
  fi
}

smoke_test() {
  local url="$1" ok_codes="$2"
  local deadline=$(( $(date +%s) + 90 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo "000")
    if [[ ",$ok_codes," == *,"$code",* ]]; then
      log "  smoke OK ($url → $code)"
      return 0
    fi
    log "  smoke pending: $url → $code (retry dans 3s)"
    sleep 3
  done
  log "  smoke FAIL après 90s ($url)"
  return 1
}

recreate_service() {
  log "  pull + recreate $SERVICE dans $COMPOSE_DIR"
  ( cd "$COMPOSE_DIR" \
      && docker compose --env-file "$ENV_FILE" pull "$SERVICE" 2>&1 | tail -3 \
      && docker compose --env-file "$ENV_FILE" up -d --force-recreate "$SERVICE" 2>&1 | tail -3 ) \
      || return 1
}

# -----------------------------------------------------------------------------
# 1. Backup
# -----------------------------------------------------------------------------
cp "$ENV_FILE" "$ENV_BACKUP"
log "✓ backup .env → $ENV_BACKUP"

# -----------------------------------------------------------------------------
# 2. Patch .env + recreate
# -----------------------------------------------------------------------------
patch_env_var "$ENV_VAR" "$TARGET" "$ENV_FILE"
log "✓ .env patché : ${ENV_VAR}=${TARGET}"

if ! recreate_service; then
  log "✗ pull/recreate a échoué — ROLLBACK"
  cp "$ENV_BACKUP" "$ENV_FILE"
  recreate_service || true
  log "✗ rollback effectué (version restaurée : $CURRENT)"
  exit 3
fi

# -----------------------------------------------------------------------------
# 3. Smoke test + rollback si KO
# -----------------------------------------------------------------------------
log "  attente startup ($SERVICE)…"
sleep 15

if ! smoke_test "$HEALTH_URL" "$HEALTH_OK_CODES"; then
  log "✗ smoke test KO — ROLLBACK"
  cp "$ENV_BACKUP" "$ENV_FILE"
  recreate_service || true
  log "✗ rollback effectué (version restaurée : $CURRENT)"
  exit 4
fi

log "✓ MAJ réussie : $SLUG $CURRENT → $TARGET"
rm -f "$ENV_BACKUP"
exit 0
