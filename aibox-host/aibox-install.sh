#!/usr/bin/env bash
# =============================================================================
# aibox-host/aibox-install.sh
# -----------------------------------------------------------------------------
# Installer one-command de l'AI Box sur un PC dédié à une entreprise.
#
# Cible : Ubuntu 22.04+ ou Debian 12+, GPU NVIDIA recommandé (sinon CPU lent).
#
# Usage :
#   sudo aibox-host/aibox-install.sh                  # install complet (BoxIA + Hermes)
#   sudo aibox-host/aibox-install.sh --hermes-only    # juste Hermes (BoxIA déjà installé)
#   sudo aibox-host/aibox-install.sh --update         # update : git pull + rebuild + restart
#   sudo aibox-host/aibox-install.sh --check          # dry-run, affiche le plan
#
# Étapes :
#   1. Pré-requis (OS, RAM, disque, GPU, root)
#   2. Docker + NVIDIA Container Toolkit
#   3. (optionnel) Stack BoxIA via tools/install.sh existant
#   4. Wizard interactif (collecte config client)
#   5. Build image hermes:fr + up Hermes
#   6. Configuration Hermes (provider, fallback local, skills)
#   7. Installation skills aibox-tools
#   8. Test E2E + résumé
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AIBOX_ROOT="/opt/aibox"
HERMES_DIR="$AIBOX_ROOT/hermes"
COMPOSE_FILE="$HERMES_DIR/docker-compose.hermes.yml"

# Helpers
log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Source les libs
. "$SCRIPT_DIR/lib/prereqs.sh"
. "$SCRIPT_DIR/lib/docker-setup.sh"
. "$SCRIPT_DIR/lib/hermes-config.sh"

# ---- Args -----------------------------------------------------------------
MODE=full
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --hermes-only) MODE=hermes ;;
    --update)      MODE=update ;;
    --check)       CHECK_ONLY=1 ;;
    -h|--help)     sed -n '2,25p' "$0"; exit 0 ;;
    *) fail "Argument inconnu : $arg" ;;
  esac
done

# ---- 1. Pré-requis ---------------------------------------------------------
log "[1/8] Pré-requis"
run_all_prereqs

# Dry-run early exit
if [ "$CHECK_ONLY" = "1" ]; then
  warn "Mode --check : pré-requis affichés, install non exécutée. Relance sans --check pour installer."
  exit 0
fi

# ---- 2. Docker + NVIDIA ---------------------------------------------------
log "[2/8] Docker + NVIDIA Container Toolkit"
setup_docker_full

# ---- 3. Stack BoxIA (réutilise install.sh existant) ------------------------
if [ "$MODE" = "full" ]; then
  log "[3/8] Stack BoxIA (Ollama + Dify + n8n + Postgres + Authentik + aibox-app + connecteurs)"
  if [ -f "$REPO_DIR/install.sh" ]; then
    log "Lancement $REPO_DIR/install.sh (peut prendre 10-15 min : pull images, init DB, premiers démarrages)"
    # AIBOX_BOOTSTRAP=1 indique : pas de questions, configuration de base, le wizard web s'occupe du reste
    AIBOX_BOOTSTRAP=1 bash "$REPO_DIR/install.sh"
    ok "Stack BoxIA déployée"
  else
    warn "$REPO_DIR/install.sh absent — saute. Tu peux le lancer manuellement avant de continuer."
  fi
else
  log "[3/8] Skip BoxIA (mode $MODE)"
fi

# ---- 4. Wizard ------------------------------------------------------------
log "[4/8] Wizard configuration AI Box"
mkdir -p "$HERMES_DIR/data"
# Chown au user 'hermes' du container (UID 10000) AVANT le up.
# Sans ça, l'entrypoint Hermes (qui tourne en hermes user après USER hermes
# dans le Dockerfile) ne peut pas créer ses sous-dossiers (cron, sessions, etc.)
# et le container entre en crashloop avec "mkdir: Permission denied".
chown -R 10000:10000 "$HERMES_DIR/data" 2>/dev/null || true
chmod 755 "$HERMES_DIR/data" 2>/dev/null || true

if [ "$MODE" != "update" ] || [ ! -f "$HERMES_DIR/.env" ]; then
  bash "$SCRIPT_DIR/wizard.sh"
else
  ok "Mode update : conserve $HERMES_DIR/.env existant"
fi

# Sanity check .env
[ -f "$HERMES_DIR/.env" ] || fail ".env Hermes absent après wizard — abort"
# shellcheck disable=SC1090
. "$HERMES_DIR/.env"

# ---- 5. Build image + Up Hermes -------------------------------------------
log "[5/8] Build image aibox-hermes:fr + Up"
# Copie compose et Dockerfile au bon endroit
cp "$SCRIPT_DIR/docker-compose.hermes.yml" "$COMPOSE_FILE"
cp "$SCRIPT_DIR/Dockerfile" "$HERMES_DIR/Dockerfile"

# S'assure que le réseau aibox_net existe (créé par stack BoxIA, sinon on le crée)
if ! docker network inspect aibox_net >/dev/null 2>&1; then
  log "Création réseau aibox_net (absent — stack BoxIA pas démarrée ?)"
  docker network create aibox_net
fi

docker compose -f "$COMPOSE_FILE" up -d --build

# Wait healthy
log "Attente container healthy (max 3 min)"
ATTEMPTS=0
while [ $ATTEMPTS -lt 18 ]; do
  HEALTH=$(docker inspect aibox-hermes --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  case "$HEALTH" in
    healthy) ok "Hermes healthy"; break ;;
    starting) printf '  health: starting (%d/18)\r' "$((ATTEMPTS+1))" ;;
    unhealthy) fail "Hermes UNHEALTHY — voir docker logs aibox-hermes" ;;
  esac
  sleep 10
  ATTEMPTS=$((ATTEMPTS+1))
done
[ "$HEALTH" = "healthy" ] || fail "Timeout : Hermes pas healthy après 3 min"

# ---- 6. Configuration Hermes (provider + fallback) ------------------------
log "[6/8] Configuration provider Hermes"
create_local_derived_model
configure_provider "${AIBOX_PROVIDER:-anthropic}"
configure_fallback_local "${AIBOX_PROVIDER:-anthropic}"
docker compose -f "$COMPOSE_FILE" restart aibox-hermes
sleep 25
ok "Provider configuré + restart"

# ---- 7. Skills aibox-tools ------------------------------------------------
log "[7/8] Installation skills aibox-tools"
install_aibox_skills "$REPO_DIR"

# ---- 8. Test E2E ----------------------------------------------------------
log "[8/8] Test E2E"
HERMES_KEY=$(grep '^API_SERVER_KEY=' "$HERMES_DIR/.env" | cut -d= -f2-)
START=$(date +%s)
RESPONSE=$(curl -s -X POST http://localhost:9119/api/v1/chat \
  -H "Authorization: Bearer $HERMES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Bonjour, qui es-tu en une phrase ?"}],"max_tokens":80}' 2>&1)
END=$(date +%s)

if echo "$RESPONSE" | grep -q 'choices'; then
  ok "Test E2E réussi (latence $((END-START))s)"
  CONTENT=$(echo "$RESPONSE" | python3 -c "import json,sys;print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "(parse failed)")
  echo "  Réponse Hermes : $CONTENT"
else
  warn "Réponse inattendue :"
  echo "$RESPONSE" | head -c 400
  echo
fi

# ---- Résumé ---------------------------------------------------------------
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✓ AI Box installée"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  Entreprise         : ${AIBOX_COMPANY_NAME:-?} (slug: ${AIBOX_COMPANY_SLUG:-?})"
echo "  Provider LLM       : ${AIBOX_PROVIDER:-?}"
if [ "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "  Telegram           : configuré (chat_ids: ${TELEGRAM_ALLOWED_USERS:-aucun})"
else
  echo "  Telegram           : NON configuré — relance aibox-host/wizard.sh pour ajouter"
fi
echo "  Dashboard Hermes   : http://$(hostname -I | awk '{print $1}'):9119"
echo "  Admin web (aibox-app) : http://$(hostname -I | awk '{print $1}'):3100"
echo ""
echo "  Commandes utiles :"
echo "    docker ps                                  # voir tous les containers"
echo "    docker logs aibox-hermes -f               # logs Hermes"
echo "    docker exec aibox-hermes /opt/hermes/.venv/bin/hermes doctor"
echo "    sudo aibox-host/aibox-install.sh --update       # update à distance"
echo "    sudo aibox-host/wizard.sh                  # modifier la config"
echo ""
