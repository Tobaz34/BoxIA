#!/usr/bin/env bash
# =============================================================================
# AI Box — installeur one-command pour VPS Ubuntu. IDEMPOTENT.
#
#   sudo ./install.sh            # installe tout
#   ./install.sh --check         # dry-run (n'exécute rien)
#
# Variables (env ; sinon défauts) :
#   COMPANY_SLUG, COMPANY_NAME
#   ANTHROPIC_API_KEY            # RECOMMANDÉ sur VPS (cloud-primary, pas de GPU)
#   WITH_LOCAL_MODEL=1           # optionnel : installe Ollama + un modèle local (lent sans GPU)
#   AIBOX_DOMAIN                 # ex: aibox.mon-domaine.fr → HTTPS auto (Caddy) pour la PWA
#   FIRST_USER_SLUG, FIRST_USER_NAME
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS   # canal du 1er user
# =============================================================================
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
if [ "$CHECK" != 1 ] && [ "$(id -u)" != 0 ]; then
  echo "À lancer en root : sudo ./install.sh"; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # = aibox-hermes/
AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"
COMPANY_SLUG="${COMPANY_SLUG:-mon-entreprise}"

run()  { if [ "$CHECK" = 1 ]; then echo "  [check] $*"; else eval "$@"; fi; }
step() { printf '\n== %s ==\n' "$*"; }

step "1/6  Dépendances système"
run "export DEBIAN_FRONTEND=noninteractive"
run "apt-get update -qq"
run "apt-get install -y -qq python3 python3-venv python3-pip git curl jq"

step "2/6  Hermes Agent (installé vierge, jamais modifié)"
if ! command -v hermes >/dev/null 2>&1; then
  run "curl -fsSL https://hermes-agent.org/install.sh | bash"
else
  echo "  hermes déjà présent."
fi

step "3/6  Modèle IA"
if [ "${WITH_LOCAL_MODEL:-0}" = 1 ]; then
  command -v ollama >/dev/null 2>&1 || run "curl -fsSL https://ollama.com/install.sh | sh"
  MODEL="$(python3 "$SCRIPT_DIR/cookbook/cookbook.py" --json 2>/dev/null | sed -n 's/.*"recommended": *"\([^"]*\)".*/\1/p')"
  MODEL="${MODEL:-qwen3:4b}"
  echo "  Cookbook recommande : $MODEL"
  run "ollama pull '$MODEL'"
  export OLLAMA_MODEL="$MODEL"
else
  echo "  Mode cloud-primary (pas de modèle local — conseillé sur VPS sans GPU)."
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  ⚠ ANTHROPIC_API_KEY non fournie : l'assistant ne pourra pas répondre tant qu'une clé n'est pas configurée."
  fi
fi

step "4/6  Config entreprise (wizard-company)"
run "AIBOX_ROOT='$AIBOX_ROOT' bash '$SCRIPT_DIR/provision/wizard-company.sh' '$COMPANY_SLUG' $([ "$CHECK" = 1 ] && echo --check)"

step "5/6  Premier utilisateur + service systemd"
if [ -n "${FIRST_USER_SLUG:-}" ]; then
  run "AIBOX_ROOT='$AIBOX_ROOT' bash '$SCRIPT_DIR/provision/wizard-user.sh' '$COMPANY_SLUG' '$FIRST_USER_SLUG' $([ "$CHECK" = 1 ] && echo --check)"
  INSTANCE="${COMPANY_SLUG}-${FIRST_USER_SLUG}"
  if [ "$CHECK" = 1 ]; then
    echo "  [check] instance systemd aibox-hermes@$INSTANCE (HERMES_HOME mappé)"
  else
    mkdir -p "$AIBOX_ROOT/instances"
    echo "HERMES_HOME=$AIBOX_ROOT/companies/$COMPANY_SLUG/users/$FIRST_USER_SLUG/hermes" \
      > "$AIBOX_ROOT/instances/$INSTANCE.env"
    install -m 644 "$SCRIPT_DIR/provision/aibox-hermes@.service" /etc/systemd/system/aibox-hermes@.service
    systemctl daemon-reload
    systemctl enable --now "aibox-hermes@$INSTANCE"
  fi
else
  echo "  (aucun FIRST_USER_SLUG — ajoute des employés ensuite, voir ci-dessous)"
fi

step "6/6  PWA + HTTPS (Caddy)"
if [ -n "${AIBOX_DOMAIN:-}" ]; then
  command -v caddy >/dev/null 2>&1 || run "apt-get install -y -qq caddy"
  if [ "$CHECK" = 1 ]; then
    echo "  [check] render Caddyfile pour $AIBOX_DOMAIN (PWA: $SCRIPT_DIR/pwa)"
  else
    sed -e "s#__DOMAIN__#$AIBOX_DOMAIN#g" -e "s#__PWA_DIR__#$SCRIPT_DIR/pwa#g" \
      "$SCRIPT_DIR/provision/Caddyfile.template" > /etc/caddy/Caddyfile
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
  fi
  echo "  PWA : https://$AIBOX_DOMAIN"
else
  echo "  (pas de AIBOX_DOMAIN — canal Telegram suffit ; la PWA web nécessite un domaine + HTTPS)"
fi

cat <<EOF

== AI Box installée ==
  Entreprise : $COMPANY_SLUG
  Données    : $AIBOX_ROOT/companies/$COMPANY_SLUG/

Ajouter un employé :
  sudo bash $SCRIPT_DIR/provision/wizard-user.sh $COMPANY_SLUG <user>
  echo "HERMES_HOME=$AIBOX_ROOT/companies/$COMPANY_SLUG/users/<user>/hermes" > $AIBOX_ROOT/instances/$COMPANY_SLUG-<user>.env
  sudo systemctl enable --now aibox-hermes@$COMPANY_SLUG-<user>

Voir INSTALL-VPS.md pour le détail (bot Telegram, domaine, dépannage).
EOF
