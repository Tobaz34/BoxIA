#!/usr/bin/env bash
# =============================================================================
# Installe la fenêtre de chat épurée (chat-ui/) pour TOUS les users provisionnés
# et branche les routes Caddy. IDEMPOTENT. Update-safe : ne touche jamais à
# ~/hermes-agent/ ; tout vit dans le web-root + /etc/caddy.
#
# Sert, derrière Authentik (:443) :
#   /aibox-chat/           -> l'UI statique (ChatGPT-like)
#   /aibox-chat/session    -> {"token": "..."} du user authentifié (X-Authentik-Username)
#   /api/ws                -> (inchangé) le dashboard Hermes du user (WebSocket)
# Le dashboard Hermes reste accessible à "/" — l'UI épurée est sous /aibox-chat/.
#
# IMPORTANT : le contenu servi vit dans WEB_ROOT (/opt/aibox-web) et NON dans le
# home de l'utilisateur : Caddy tourne en tant que user `caddy` qui ne peut pas
# traverser /home/clikinfo (pas de bit d'exécution). Le web-root est root:caddy.
#
# Usage : sudo -E install-web-chat.sh [--reload-caddy]
# Env   : AIBOX_ROOT (def. /home/clikinfo/aibox)   # données Hermes + dash envs
#         WEB_ROOT   (def. /opt/aibox-web)         # contenu servi par Caddy
#         CADDYFILE  (def. /etc/caddy/Caddyfile)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AIBOX_ROOT="${AIBOX_ROOT:-/home/clikinfo/aibox}"
WEB_ROOT="${WEB_ROOT:-/opt/aibox-web}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
DASH_DIR="$AIBOX_ROOT/dash"
CADDY_USER="$(systemctl show caddy -p User --value 2>/dev/null || true)"; CADDY_USER="${CADDY_USER:-caddy}"

echo "== install-web-chat (WEB_ROOT=$WEB_ROOT, caddy=$CADDY_USER) =="

# 1) UI statique (aucun secret) ----------------------------------------------
sudo mkdir -p "$WEB_ROOT/chat-ui"
sudo cp -f "$AIBOX_HERMES_DIR/chat-ui/index.html" \
           "$AIBOX_HERMES_DIR/chat-ui/chat.css" \
           "$AIBOX_HERMES_DIR/chat-ui/chat.js" "$WEB_ROOT/chat-ui/"
sudo chown -R "root:$CADDY_USER" "$WEB_ROOT/chat-ui"
sudo chmod 755 "$WEB_ROOT" "$WEB_ROOT/chat-ui"
sudo chmod 644 "$WEB_ROOT/chat-ui/"*
echo "  UI -> $WEB_ROOT/chat-ui"

# 1bis) Documentation Hermes EN LOCAL (hors-ligne) : viewer statique + contenu
#       généré depuis la doc Docusaurus de Hermes (snapshot, à rejouer après MAJ).
sudo mkdir -p "$WEB_ROOT/docs/vendor"
sudo cp -f "$AIBOX_HERMES_DIR/docs-ui/index.html" "$AIBOX_HERMES_DIR/docs-ui/docs.css" \
           "$AIBOX_HERMES_DIR/docs-ui/docs.js" "$WEB_ROOT/docs/"
sudo cp -f "$AIBOX_HERMES_DIR/docs-ui/vendor/"*.js "$WEB_ROOT/docs/vendor/"
HERMES_DOCS="${HERMES_DOCS:-$HOME/hermes-agent/website/docs}"
if [ -d "$HERMES_DOCS" ]; then
  sudo python3 "$AIBOX_HERMES_DIR/provision/build-docs.py" "$HERMES_DOCS" "$WEB_ROOT/docs"
  echo "  docs -> $WEB_ROOT/docs (générées depuis $HERMES_DOCS)"
else
  echo "  ! docs Hermes introuvables ($HERMES_DOCS) — viewer servi sans contenu"
fi
sudo chown -R "root:$CADDY_USER" "$WEB_ROOT/docs"
sudo find "$WEB_ROOT/docs" -type d -exec chmod 755 {} \;
sudo find "$WEB_ROOT/docs" -type f -exec chmod 644 {} \;

# 2) Token par user : chaque dash env DOIT avoir HERMES_DASHBOARD_SESSION_TOKEN
#    (sinon le dashboard en génère un aléatoire au démarrage = /api/ws en 403).
sudo mkdir -p "$WEB_ROOT/chat-tokens"
for envf in "$DASH_DIR"/*.env; do
  [ -e "$envf" ] || continue
  u="$(basename "$envf" .env)"
  if ! grep -q '^HERMES_DASHBOARD_SESSION_TOKEN=' "$envf"; then
    echo "HERMES_DASHBOARD_SESSION_TOKEN=aibox-$(openssl rand -hex 13)" >> "$envf"
    echo "  + token généré pour $u -> restart aibox-dash@$u"
    systemctl is-enabled "aibox-dash@$u" >/dev/null 2>&1 && sudo systemctl restart "aibox-dash@$u" || true
  fi
  t="$(grep -oP '^HERMES_DASHBOARD_SESSION_TOKEN=\K.*' "$envf" || true)"
  printf '{"token":"%s"}\n' "$t" | sudo tee "$WEB_ROOT/chat-tokens/$u.json" >/dev/null
done
sudo chown -R "root:$CADDY_USER" "$WEB_ROOT/chat-tokens"
sudo chmod 750 "$WEB_ROOT/chat-tokens"
sudo bash -c "chmod 640 '$WEB_ROOT/chat-tokens/'*.json"
echo "  tokens -> $WEB_ROOT/chat-tokens (lisibles par groupe $CADDY_USER uniquement)"

# 3) Caddy : le bloc à insérer dans le site :443 (voir provision/caddy-aibox-chat.snippet)
if ! grep -q 'AIBOX-CHAT-BEGIN' "$CADDYFILE" 2>/dev/null; then
  echo "  >> Caddy NON patché : insère provision/caddy-aibox-chat.snippet dans le 'route {}'"
  echo "     du site :443, juste avant 'map ... {backend}'. Roots = $WEB_ROOT/chat-{tokens,ui}."
else
  echo "  Caddy déjà patché (marqueur AIBOX-CHAT-BEGIN présent)"
fi

if [ "${1:-}" = "--reload-caddy" ]; then
  sudo caddy validate --config "$CADDYFILE" --adapter caddyfile && \
  sudo systemctl reload caddy && echo "  caddy reloaded"
fi
echo "== OK — teste https://<host>/aibox-chat/ =="
