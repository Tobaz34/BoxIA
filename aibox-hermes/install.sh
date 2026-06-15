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
WITH_WEB_PORTAL="${WITH_WEB_PORTAL:-1}"   # portail web multi-user (Authentik+Caddy+chat) — défaut LAN
AIBOX_OWNER="${AIBOX_OWNER:-$(logname 2>/dev/null || echo clikinfo)}"
# Le portail web tourne sous le compte de l'owner (dashboards systemd, HERMES_HOME).
if [ "$WITH_WEB_PORTAL" = 1 ]; then AIBOX_ROOT="${AIBOX_ROOT:-/home/$AIBOX_OWNER/aibox}"; else AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"; fi
COMPANY_SLUG="${COMPANY_SLUG:-demo}"

run()  { if [ "$CHECK" = 1 ]; then echo "  [check] $*"; else eval "$@"; fi; }
step() { printf '\n== %s ==\n' "$*"; }
# Exécute en tant que propriétaire du portail : Hermes, HERMES_HOME et les données
# lui appartiennent (le dashboard tourne sous ce compte) — pas root. bash -lc → PATH
# (~/.local/bin pour uv/hermes). En portail web l'owner = clikinfo ; sinon = invoquant.
OWNER_RUN="$AIBOX_OWNER"
asowner() { if [ "$CHECK" = 1 ]; then echo "  [check][$OWNER_RUN] $*"; else sudo -u "$OWNER_RUN" -H bash -lc "$*"; fi; }
have_hermes() { sudo -u "$OWNER_RUN" -H bash -lc 'command -v hermes >/dev/null 2>&1' 2>/dev/null; }

step "1/7  Dépendances système"
run "export DEBIAN_FRONTEND=noninteractive"
run "apt-get update -qq"
run "apt-get install -y -qq python3 python3-venv python3-pip git curl jq"

step "2/7  Hermes Agent (installé pour $OWNER_RUN, jamais modifié)"
# Vraie méthode (vérifiée live) : clone + setup-hermes.sh via uv (non-interactif),
# EN TANT QUE l'owner → ~/.local/bin/hermes et ~/hermes-agent lui appartiennent.
if [ "$CHECK" = 1 ] || ! have_hermes; then
  asowner 'command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh'
  asowner '[ -d ~/hermes-agent/.git ] || git clone --depth 1 https://github.com/nousresearch/hermes-agent.git ~/hermes-agent'
  asowner 'cd ~/hermes-agent && yes n | ./setup-hermes.sh'
else
  echo "  hermes déjà présent ($OWNER_RUN)."
fi
# Frontend du dashboard web : setup-hermes ne le build PAS → sans ça, le service
# `hermes dashboard --skip-build` échoue (« no web dist »). On installe node + build.
if [ "$WITH_WEB_PORTAL" = 1 ]; then
  command -v node >/dev/null 2>&1 || run "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y -qq nodejs"
  asowner 'cd ~/hermes-agent && npm install --workspace web && npm run build -w web'
  echo "  dashboard web buildé (hermes_cli/web_dist)"
fi

step "3/7  Modèle IA"
if [ "${WITH_LOCAL_MODEL:-0}" = 1 ]; then
  command -v ollama >/dev/null 2>&1 || run "curl -fsSL https://ollama.com/install.sh | sh"
  run "sudo systemctl enable --now ollama 2>/dev/null || true"   # l'install laisse le service désactivé
  MODEL="$(python3 "$SCRIPT_DIR/cookbook/cookbook.py" --json 2>/dev/null | sed -n 's/.*"recommended": *"\([^"]*\)".*/\1/p')"
  MODEL="${MODEL:-qwen3:4b}"
  echo "  Cookbook recommande : $MODEL"
  run "ollama pull '$MODEL'"
  export OLLAMA_MODEL="$MODEL"
  # Modèle vision (pièces jointes image — « analyse cette facture/photo »)
  VISION_MODEL="${VISION_MODEL:-qwen2.5vl:7b}"
  [ -n "$VISION_MODEL" ] && run "ollama pull '$VISION_MODEL'"
else
  echo "  Mode cloud-primary (pas de modèle local — conseillé sur VPS sans GPU)."
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  ⚠ ANTHROPIC_API_KEY non fournie : l'assistant ne pourra pas répondre tant qu'une clé n'est pas configurée."
  fi
fi

step "4/7  Config entreprise (wizard-company)"
asowner "AIBOX_ROOT='$AIBOX_ROOT' OLLAMA_MODEL='${OLLAMA_MODEL:-}' ENABLED_CONNECTORS='${ENABLED_CONNECTORS:-}' ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}' bash '$SCRIPT_DIR/provision/wizard-company.sh' '$COMPANY_SLUG' $([ "$CHECK" = 1 ] && echo --check)"

step "5/7  Premier utilisateur"
if [ -n "${FIRST_USER_SLUG:-}" ]; then
  asowner "AIBOX_ROOT='$AIBOX_ROOT' bash '$SCRIPT_DIR/provision/wizard-user.sh' '$COMPANY_SLUG' '$FIRST_USER_SLUG' $([ "$CHECK" = 1 ] && echo --check)"
  # Hors portail web : service gateway (Telegram/CLI). En portail, c'est aibox-dash@ (étape 7).
  if [ "$WITH_WEB_PORTAL" != 1 ]; then
    INSTANCE="${COMPANY_SLUG}-${FIRST_USER_SLUG}"
    if [ "$CHECK" = 1 ]; then echo "  [check] instance systemd aibox-hermes@$INSTANCE"; else
      asowner "mkdir -p '$AIBOX_ROOT/instances' && echo \"HERMES_HOME=$AIBOX_ROOT/companies/$COMPANY_SLUG/users/$FIRST_USER_SLUG/hermes\" > '$AIBOX_ROOT/instances/$INSTANCE.env'"
      install -m 644 "$SCRIPT_DIR/provision/aibox-hermes@.service" /etc/systemd/system/aibox-hermes@.service
      systemctl daemon-reload; systemctl enable --now "aibox-hermes@$INSTANCE"
    fi
  fi
else
  echo "  (aucun FIRST_USER_SLUG — ajoute des employés ensuite, voir ci-dessous)"
fi

step "6/7  PWA + HTTPS (Caddy)"
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

step "7/7  Portail web multi-utilisateur (Authentik + Caddy + dashboards + chat)"
if [ "$WITH_WEB_PORTAL" = 1 ]; then
  AIBOX_HOST="${AIBOX_HOST:-${AIBOX_DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}}"
  run "command -v caddy >/dev/null 2>&1 || apt-get install -y -qq caddy"
  run "command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh"
  run "ufw allow 80/tcp 2>/dev/null; ufw allow 443/tcp 2>/dev/null; ufw allow 9443/tcp 2>/dev/null; true"
  # 7a) Authentik (login) — secrets auto-générés
  run "AIBOX_OWNER='$AIBOX_OWNER' AKADMIN_PASSWORD='${AKADMIN_PASSWORD:-AiBoxAdmin2026!Change}' bash '$SCRIPT_DIR/provision/authentik/deploy-authentik.sh' $([ "$CHECK" = 1 ] && echo --check)"
  # 7b) Portail : dashboards par user + Caddy + contenu web + config Authentik
  run "AIBOX_ROOT='$AIBOX_ROOT' AIBOX_OWNER='$AIBOX_OWNER' COMPANY='$COMPANY_SLUG' AIBOX_HOST='$AIBOX_HOST' USER_PASSWORD='${USER_PASSWORD:-1234}' AIBOX_ADMINS='${AIBOX_ADMINS:-}' bash '$SCRIPT_DIR/provision/setup-portal.sh' $([ "$CHECK" = 1 ] && echo --check)"
  # 7c) Les données du portail dans le home de l'owner doivent lui appartenir
  #     (dash env + roles.json sont écrits par root ; le dashboard/plugin droits écrit en tant qu'owner).
  run "chown -R '$AIBOX_OWNER':'$AIBOX_OWNER' '$AIBOX_ROOT/dash' 2>/dev/null; [ -f '$AIBOX_ROOT/roles.json' ] && chown '$AIBOX_OWNER':'$AIBOX_OWNER' '$AIBOX_ROOT/roles.json'; true"
  echo "  Portail : https://$AIBOX_HOST/  (login Authentik akadmin + employés, chat en page d'accueil)"
else
  echo "  (WITH_WEB_PORTAL=0 — portail web non installé)"
fi

cat <<EOF

== AI Box installée ==
  Entreprise : $COMPANY_SLUG
  Données    : $AIBOX_ROOT/companies/$COMPANY_SLUG/

Ajouter un employé (portail web) :
  sudo bash $SCRIPT_DIR/provision/wizard-user.sh $COMPANY_SLUG <user>
  sudo -E AIBOX_ROOT='$AIBOX_ROOT' AIBOX_HOST='${AIBOX_HOST:-<ip>}' bash $SCRIPT_DIR/provision/setup-portal.sh
  # (setup-portal est idempotent : il crée le dashboard du nouvel user, son token,
  #  l'ajoute au routage Caddy et le crée dans Authentik.)

Voir INSTALL-VPS.md pour le détail (bot Telegram, domaine, dépannage).
EOF
