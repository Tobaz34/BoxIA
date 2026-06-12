#!/usr/bin/env bash
# =============================================================================
# tools/redeploy-wizard.sh
# -----------------------------------------------------------------------------
# Re-déploie UNIQUEMENT le wizard de setup (services/setup) sur une box.
# Plus rapide qu'un wipe + deploy-new-box complet quand on a juste fixé un
# bug dans le wizard (main.py, wizard.html, wizard.js, etc.).
#
# Étapes :
#   1. git fetch + reset --hard origin/<branch> dans /srv/ai-stack/
#   2. cd services/setup && docker compose up -d --build (rebuild image)
#
# La stack principale (Authentik, Dify, n8n, etc.) n'est PAS touchée.
# Le wizard est restart en ~30s (pas de wipe des volumes).
#
# Usage :
#   ./tools/redeploy-wizard.sh <ssh-target> [--branch <ref>] [--port <N>]
# =============================================================================
set -euo pipefail

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*" >&2; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*" >&2; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }

SSH_TARGET=""
BRANCH="main"
SETUP_PORT="${SETUP_PORT:-80}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --port)   SETUP_PORT="$2"; shift 2 ;;
    *)
      if [[ -z "$SSH_TARGET" ]]; then SSH_TARGET="$1"; else c_red "Arg inattendu: $1"; exit 1; fi
      shift
      ;;
  esac
done

if [[ -z "$SSH_TARGET" ]]; then
  c_red "Usage: $0 <ssh-target> [--branch main] [--port 80]"
  exit 1
fi

REMOTE_PATH="${REMOTE_PATH:-/srv/ai-stack}"

c_blue "→ Cible      : $SSH_TARGET"
c_blue "→ Branche    : $BRANCH"
c_blue "→ Port wizard: $SETUP_PORT"

c_blue "→ Sync code via git fetch + reset..."
ssh "$SSH_TARGET" "
  set -e
  cd $REMOTE_PATH
  git fetch origin '$BRANCH'
  git reset --hard 'origin/$BRANCH'
  echo '  HEAD :' \$(git rev-parse --short HEAD) '(' \$(git log -1 --pretty=%s | head -c 70) ')'
"

c_blue "→ Rebuild + restart wizard (services/setup)..."
ssh "$SSH_TARGET" "
  set -e
  cd $REMOTE_PATH/services/setup
  SETUP_PORT=$SETUP_PORT docker compose --env-file ../../.env up -d --build 2>&1 | tail -20
"

c_blue "→ Vérification que le wizard répond..."
sleep 3
BOX_IP=$(ssh "$SSH_TARGET" "hostname -I | awk '{print \$1}'")
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://$BOX_IP:$SETUP_PORT/" || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  c_green "✓ Wizard accessible sur http://$BOX_IP:$SETUP_PORT (HTTP $HTTP_CODE)"
else
  c_red "✗ Wizard répond HTTP $HTTP_CODE — investiguer :"
  c_red "    ssh $SSH_TARGET 'docker logs aibox-setup-api --tail 30'"
  exit 1
fi
