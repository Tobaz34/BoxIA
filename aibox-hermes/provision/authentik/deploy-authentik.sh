#!/usr/bin/env bash
# =============================================================================
# Déploie le conteneur Authentik (login portail). IDEMPOTENT. Secrets
# AUTO-GÉNÉRÉS au 1er run (principe « zéro intervention »), puis préservés.
# La config métier (provider/app/outpost/marque/users) est posée ensuite par
# setup-authentik.py (via setup-portal.sh).
#
# Usage : sudo -E deploy-authentik.sh [--check]
# Env :
#   AUTHENTIK_DIR    (def /home/<owner>/aibox/authentik)
#   AIBOX_OWNER      (def clikinfo)
#   AKADMIN_PASSWORD (def AiBoxAdmin2026!Change)  mot de passe akadmin initial
#   AUTHENTIK_TAG    (def 2026.5.3)
#   COMPOSE_PORT_HTTPS (def 9443)  port login (séparé pour éviter collision dashboard)
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWNER="${AIBOX_OWNER:-clikinfo}"
DIR="${AUTHENTIK_DIR:-/home/$OWNER/aibox/authentik}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
run() { if [ "$CHECK" = 1 ]; then echo "    [check] $*"; else eval "$@"; fi; }

echo "== deploy-authentik ($DIR) =="
run "mkdir -p '$DIR/data' '$DIR/certs' '$DIR/custom-templates'"
run "cp '$SCRIPT_DIR/docker-compose.yml' '$DIR/docker-compose.yml'"

if [ "$CHECK" = 1 ]; then
  echo "    [check] générer $DIR/.env (PG_PASS, SECRET_KEY, BOOTSTRAP_PASSWORD/TOKEN aléatoires) si absent"
elif [ ! -f "$DIR/.env" ]; then
  umask 077
  cat > "$DIR/.env" <<EOF
PG_DB=authentik
PG_USER=authentik
PG_PASS=$(openssl rand -hex 24)
AUTHENTIK_SECRET_KEY=$(openssl rand -hex 40)
AUTHENTIK_BOOTSTRAP_PASSWORD=${AKADMIN_PASSWORD:-AiBoxAdmin2026!Change}
AUTHENTIK_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
AUTHENTIK_ERROR_REPORTING__ENABLED=false
AUTHENTIK_TAG=${AUTHENTIK_TAG:-2026.5.3}
COMPOSE_PORT_HTTP=9000
COMPOSE_PORT_HTTPS=${COMPOSE_PORT_HTTPS:-9443}
EOF
  chown "$OWNER:$OWNER" "$DIR/.env"
  echo "  .env généré (secrets aléatoires)"
else
  echo "  .env déjà présent — préservé"
fi

run "cd '$DIR' && docker compose up -d"

# Attente readiness (l'outpost embarqué + l'API doivent répondre)
if [ "$CHECK" != 1 ]; then
  echo -n "  attente Authentik"
  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9000/-/health/ready/ >/dev/null 2>&1; then echo " — prêt"; break; fi
    echo -n "."; sleep 5
  done
fi
echo "== Authentik déployé (login: akadmin / \$AKADMIN_PASSWORD) =="
