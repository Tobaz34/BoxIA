#!/usr/bin/env bash
# =============================================================================
# deploy-hermes-to-xefia.sh
# -----------------------------------------------------------------------------
# Déploie / re-déploie Hermes Agent sur xefia (stack standalone, hors BoxIA).
# Idempotent : peut être rejoué à volonté, ne casse pas l'état existant.
#
# Usage :
#   tools/deploy-hermes-to-xefia.sh            # déploie / met à jour
#   tools/deploy-hermes-to-xefia.sh --check    # dry-run, affiche le plan
#   tools/deploy-hermes-to-xefia.sh --rotate-key  # régénère API_SERVER_KEY
#
# Cohabitation BoxIA :
#   Ce script touche UNIQUEMENT /srv/xefia/hermes* + /srv/xefia/hermes_data*.
#   Il ne modifie jamais /srv/ai-stack/ (BoxIA) — c'est un stack séparé sur
#   le même serveur, branché sur le réseau ollama_net partagé.
#
# Étapes (idempotentes) :
#   1. Pré-flight  : ollama_net présent, ports libres, qwen3:14b dans Ollama
#   2. Modèle      : create qwen3:14b-64k (num_ctx 65536) si absent
#   3. Dossiers    : mkdir /srv/xefia/hermes/ + /srv/xefia/hermes_data/
#   4. Fichiers    : push Dockerfile + docker-compose.yml via SSH
#   5. Secrets     : génère .env + .api_key si absents (preserve sinon)
#   6. Image       : docker compose build (skip si rien à changer)
#   7. Container   : docker compose up -d, wait healthy
#   8. Config      : hermes config set provider/base_url/default/context_length
#   9. Migration   : OpenClaw → Hermes si /srv/xefia/openclaw_config/ existe
#                    et que la migration n'a pas déjà tourné
#  10. Validation  : test /v1/chat/completions
# =============================================================================
set -euo pipefail

# ---- Config ---------------------------------------------------------------
SSH_HOST="${HERMES_SSH_HOST:-clikinfo@192.168.15.210}"
HERMES_DIR="/srv/xefia/hermes"
HERMES_DATA="/srv/xefia/hermes_data"
OPENCLAW_CONFIG="/srv/xefia/openclaw_config"
COMPOSE_FILE="$HERMES_DIR/docker-compose.yml"
MODEL_BASE="qwen3:14b"
MODEL_DERIVED="qwen3:14b-64k"
NUM_CTX=65536
CONTAINER="hermes"
DASHBOARD_PORT=9119
GATEWAY_PORT=8642

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL_DIR="$SCRIPT_DIR/hermes"

CHECK_ONLY=0
ROTATE_KEY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --rotate-key) ROTATE_KEY=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

# ---- Helpers --------------------------------------------------------------
log()   { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Lecture: toujours exécutée (read-only, safe en dry-run pour observer l'état)
run_ssh_read() {
  ssh -o BatchMode=yes "$SSH_HOST" "$1"
}

# Écriture: respecte --check. Affiche la commande sans l'exécuter en dry-run.
run_ssh() {
  if [ "$CHECK_ONLY" = "1" ]; then
    printf '\033[2m[dry-run] ssh %s\033[0m\n' "$1" >&2
  else
    ssh -o BatchMode=yes "$SSH_HOST" "$1"
  fi
}

# Streame un fichier local vers un path serveur. Vérifie que le path
# est bien sous /srv/xefia/hermes* (sinon le hook bloquerait).
push_file() {
  local src="$1" dest="$2"
  case "$dest" in
    /srv/xefia/hermes/*|/srv/xefia/hermes_data/*) : ;;
    *) fail "push_file refuse dest=$dest (hors scope /srv/xefia/hermes*)" ;;
  esac
  [ -f "$src" ] || fail "Source absente : $src"
  if [ "$CHECK_ONLY" = "1" ]; then
    printf '\033[2m[dry-run] push %s → %s (%d bytes)\033[0m\n' "$src" "$dest" "$(wc -c < "$src")" >&2
  else
    cat "$src" | ssh -o BatchMode=yes "$SSH_HOST" "cat > '$dest'"
  fi
}

# ---- Pré-requis locaux ----------------------------------------------------
[ -d "$TPL_DIR" ] || fail "Dossier template absent : $TPL_DIR"
for f in Dockerfile docker-compose.yml Modelfile.qwen3-14b-64k; do
  [ -f "$TPL_DIR/$f" ] || fail "Fichier template manquant : $TPL_DIR/$f"
done
ok "Templates locaux présents"

# ---- 1. Pré-flight serveur ------------------------------------------------
log "[1/10] Pré-flight serveur"
PREFLIGHT=$(run_ssh_read '
  set -e
  echo "::ollama_net::$(docker network inspect ollama_net --format "{{.Driver}}" 2>/dev/null || echo MISSING)"
  echo "::port8642::$(ss -tlnp 2>/dev/null | grep -c ":8642 " || echo 0)"
  echo "::port9119::$(ss -tlnp 2>/dev/null | grep -c ":9119 " || echo 0)"
  echo "::base_model::$(docker exec ollama ollama list 2>/dev/null | awk "NR>1 && \$1==\"'"$MODEL_BASE"'\" {print \"PRESENT\"; exit}" || echo MISSING)"
  echo "::derived_model::$(docker exec ollama ollama list 2>/dev/null | awk "NR>1 && \$1==\"'"$MODEL_DERIVED"'\" {print \"PRESENT\"; exit}" || echo MISSING)"
  echo "::env_file::$(test -f '"$HERMES_DIR"'/.env && echo PRESENT || echo MISSING)"
  echo "::container::$(docker inspect '"$CONTAINER"' --format "{{.State.Status}}" 2>/dev/null || echo ABSENT)"
  echo "::openclaw::$(test -d '"$OPENCLAW_CONFIG"' && echo PRESENT || echo ABSENT)"
')
echo "$PREFLIGHT"

get_field() { echo "$PREFLIGHT" | sed -nE "s/^::$1::(.*)$/\1/p"; }
[ "$(get_field ollama_net)" = "bridge" ] || fail "Réseau ollama_net absent ou non-bridge"
ok "ollama_net OK"

if [ "$(get_field container)" != "running" ]; then
  PORT_BUSY_8642=$(get_field port8642)
  PORT_BUSY_9119=$(get_field port9119)
  [ "$PORT_BUSY_8642" = "0" ] || warn "Port 8642 occupé par un autre process (Hermes garde 8642 interne donc OK)"
  [ "$PORT_BUSY_9119" = "0" ] || fail "Port 9119 occupé par un autre process (Hermes publie ici)"
fi

[ "$(get_field base_model)" = "PRESENT" ] || fail "Modèle $MODEL_BASE absent — \`docker exec ollama ollama pull $MODEL_BASE\`"
ok "Modèle $MODEL_BASE présent"

# ---- 2. Modèle dérivé qwen3:14b-64k --------------------------------------
log "[2/10] Modèle dérivé $MODEL_DERIVED (num_ctx $NUM_CTX)"
if [ "$(get_field derived_model)" = "PRESENT" ]; then
  ok "$MODEL_DERIVED déjà présent — skip create"
else
  log "Création de $MODEL_DERIVED via Modelfile"
  MODELFILE_CONTENT=$(cat "$TPL_DIR/Modelfile.qwen3-14b-64k")
  run_ssh "
    set -e
    printf '%s\n' \"$MODELFILE_CONTENT\" | docker exec -i ollama sh -c 'cat > /tmp/Modelfile.qwen3-64k'
    docker exec ollama ollama create $MODEL_DERIVED -f /tmp/Modelfile.qwen3-64k
  "
  ok "$MODEL_DERIVED créé"
fi

# ---- 3. Dossiers ----------------------------------------------------------
log "[3/10] Dossiers $HERMES_DIR + $HERMES_DATA"
# chmod tolérant aux re-runs : /srv/xefia/hermes_data est chown 'hermes:hermes' (UID 10000)
# par le container au premier boot, clikinfo ne pourra plus le chmod ensuite.
run_ssh "
  mkdir -p '$HERMES_DIR' '$HERMES_DATA'
  chmod 755 '$HERMES_DIR' 2>/dev/null || true
  chmod 755 '$HERMES_DATA' 2>/dev/null || true
  true
"
ok "Dossiers OK"

# ---- 4. Fichiers compose + Dockerfile -------------------------------------
log "[4/10] Push templates → serveur"
push_file "$TPL_DIR/Dockerfile" "$HERMES_DIR/Dockerfile"
push_file "$TPL_DIR/docker-compose.yml" "$HERMES_DIR/docker-compose.yml"
push_file "$TPL_DIR/Modelfile.qwen3-14b-64k" "$HERMES_DIR/Modelfile.qwen3-14b-64k"
push_file "$TPL_DIR/n8n-hermes-chat.json" "$HERMES_DIR/n8n-hermes-chat.json"
push_file "$TPL_DIR/README.md" "$HERMES_DIR/README.md"
ok "Templates pushed"

# ---- 5. Secrets (.env + .api_key) -----------------------------------------
log "[5/10] Secrets"
if [ "$ROTATE_KEY" = "1" ] || [ "$(get_field env_file)" = "MISSING" ]; then
  if [ "$ROTATE_KEY" = "1" ]; then
    warn "ROTATE_KEY=1 — régénération de API_SERVER_KEY (les clients existants devront mettre à jour)"
  else
    log ".env absent — génération initiale"
  fi
  run_ssh "
    set -e
    HERMES_KEY=\$(openssl rand -hex 24)
    cat > '$HERMES_DIR/.env' <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=$GATEWAY_PORT
API_SERVER_KEY=\${HERMES_KEY}
HERMES_DASHBOARD=1
TZ=Europe/Paris
EOF
    chmod 600 '$HERMES_DIR/.env'
    echo \"\$HERMES_KEY\" > '$HERMES_DIR/.api_key'
    chmod 600 '$HERMES_DIR/.api_key'
  "
  ok ".env + .api_key générés"
else
  ok ".env existant préservé (utilise --rotate-key pour régénérer)"
fi

# ---- 6. Build image -------------------------------------------------------
log "[6/10] Build image hermes:iabox"
run_ssh "docker compose -f '$COMPOSE_FILE' build 2>&1 | tail -5"
ok "Image build OK"

# ---- 7. Up + healthcheck --------------------------------------------------
log "[7/10] Up + wait healthy"
run_ssh "docker compose -f '$COMPOSE_FILE' up -d"

if [ "$CHECK_ONLY" = "0" ]; then
  ATTEMPTS=0
  MAX_ATTEMPTS=12  # 12 × 10s = 2 min
  while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    HEALTH=$(run_ssh "docker inspect $CONTAINER --format '{{.State.Health.Status}}' 2>/dev/null" || echo "missing")
    case "$HEALTH" in
      healthy) ok "Container healthy"; break ;;
      starting) log "  health: starting (tentative $((ATTEMPTS+1))/$MAX_ATTEMPTS)" ;;
      unhealthy) fail "Container UNHEALTHY — voir logs : docker logs $CONTAINER" ;;
      *) log "  health: $HEALTH (tentative $((ATTEMPTS+1))/$MAX_ATTEMPTS)" ;;
    esac
    sleep 10
    ATTEMPTS=$((ATTEMPTS+1))
  done
  if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
    fail "Timeout: container jamais healthy après $((MAX_ATTEMPTS * 10))s"
  fi
fi

# ---- 8. Config provider Ollama (idempotent) -------------------------------
log "[8/10] Config provider Ollama via hermes config set"
run_ssh "
  set -e
  HERMES_BIN='/opt/hermes/.venv/bin/hermes'
  docker exec $CONTAINER \$HERMES_BIN config set model.provider custom >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set model.base_url http://ollama:11434/v1 >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set model.default $MODEL_DERIVED >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set model.context_length $NUM_CTX >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set auxiliary.compression.model $MODEL_DERIVED >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set auxiliary.compression.context_length $NUM_CTX >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set auxiliary.compression.base_url http://ollama:11434/v1 >/dev/null
  docker exec $CONTAINER \$HERMES_BIN config set auxiliary.compression.provider custom >/dev/null
"
# Restart pour reload config (hermes config set ne le fait pas tout seul)
run_ssh "docker compose -f '$COMPOSE_FILE' restart $CONTAINER"
sleep 25
ok "Config Hermes appliquée + restart"

# ---- 9. Migration OpenClaw (si applicable) --------------------------------
log "[9/10] Migration OpenClaw"
if [ "$(get_field openclaw)" = "PRESENT" ]; then
  ALREADY_MIGRATED=$(run_ssh_read "docker exec $CONTAINER sh -c 'ls /opt/data/migration/openclaw/ 2>/dev/null | head -1' 2>/dev/null || echo ''")
  if [ -n "$ALREADY_MIGRATED" ]; then
    ok "OpenClaw déjà migré (snapshot $ALREADY_MIGRATED) — skip"
  else
    log "Migration OpenClaw → Hermes (copie + hermes claw migrate)"
    run_ssh "
      set -e
      docker cp $OPENCLAW_CONFIG $CONTAINER:/tmp/openclaw_src
      docker exec $CONTAINER /opt/hermes/.venv/bin/hermes claw migrate --source /tmp/openclaw_src --yes 2>&1 | tail -10
      docker exec $CONTAINER rm -rf /tmp/openclaw_src
    "
    # Migration --overwrite peut écraser model.default → on le restore
    run_ssh "docker exec $CONTAINER /opt/hermes/.venv/bin/hermes config set model.default $MODEL_DERIVED >/dev/null"
    run_ssh "docker compose -f '$COMPOSE_FILE' restart $CONTAINER"
    sleep 25
    ok "Migration OpenClaw terminée"
  fi
else
  ok "Pas d'OpenClaw à migrer ($OPENCLAW_CONFIG absent) — skip"
fi

# ---- 10. Validation E2E ---------------------------------------------------
log "[10/10] Validation E2E /v1/chat/completions"
if [ "$CHECK_ONLY" = "0" ]; then
  RESULT=$(run_ssh "
    HERMES_KEY=\$(cat '$HERMES_DIR/.api_key')
    docker run --rm --network ollama_net curlimages/curl:latest -s -X POST \
      -H \"Authorization: Bearer \$HERMES_KEY\" \
      -H 'Content-Type: application/json' \
      'http://hermes:8642/v1/chat/completions' \
      -d '{\"model\":\"$MODEL_DERIVED\",\"messages\":[{\"role\":\"user\",\"content\":\"/no_think dis OK\"}],\"stream\":false,\"max_tokens\":30}'
  ")
  echo "$RESULT" | head -c 400
  echo
  if echo "$RESULT" | grep -q '"finish_reason"'; then
    ok "Test E2E réussi"
  else
    warn "Réponse inattendue (voir ci-dessus)"
  fi
fi

echo ""
ok "==============================================="
ok "  Déploiement Hermes Agent terminé"
ok "==============================================="
echo ""
echo "  Dashboard      : http://192.168.15.210:9119"
echo "  API gateway    : http://hermes:8642 (interne ollama_net)"
echo "  Clé API        : cat /srv/xefia/hermes/.api_key (depuis le serveur)"
echo "  Doc complète   : /srv/xefia/hermes/README.md (ou tools/hermes/README.md)"
echo ""
echo "  Pour activer Telegram : cf. README section 'Connexion Telegram'."
