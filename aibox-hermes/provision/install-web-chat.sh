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
# Env   : AIBOX_ROOT (def. /home/clikinfo/aibox)   # données Hermes + webui envs
#         WEBUI_DIR  (def. $AIBOX_ROOT/webui)      # source de vérité des users (*.env)
#         WEB_ROOT   (def. /opt/aibox-web)         # contenu servi par Caddy
#         CADDYFILE  (def. /etc/caddy/Caddyfile)
#         AIBOX_ADMINS (csv)                        # users promus admin dans roles.json
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AIBOX_ROOT="${AIBOX_ROOT:-/home/clikinfo/aibox}"
WEB_ROOT="${WEB_ROOT:-/opt/aibox-web}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
# SOURCE DE VÉRITÉ des users = webui/*.env (un fichier par employé, écrit par
# setup-portal.sh). L'ancienne stack utilisait dash/*.env ; sur une install fraîche
# ce dossier n'existe plus → 0 user, roles.json reste {} et TOUT LE MONDE devient
# « client » (deadlock admin). On lit donc webui/, cohérent avec setup-portal.
# WEBUI_DIR est surchargeable pour compat/rétro (ex. installs mixtes).
WEBUI_DIR="${WEBUI_DIR:-$AIBOX_ROOT/webui}"
# nullglob : un glob sans correspondance s'efface au lieu de rester littéral → évite
# de tuer le script (set -e) sur un répertoire vide (boucles for + chmod plus bas).
shopt -s nullglob
CADDY_USER="$(systemctl show caddy -p User --value 2>/dev/null || true)"; CADDY_USER="${CADDY_USER:-caddy}"

echo "== install-web-chat (WEB_ROOT=$WEB_ROOT, caddy=$CADDY_USER) =="

# 1) UI statique (aucun secret) — copie TOUT chat-ui/ -------------------------
# index.html/chat.css/chat.js + PWA (manifest.json/icon.svg/sw.js) + vendor/
# (marked/purify/highlight — sinon Markdown en texte brut).
sudo mkdir -p "$WEB_ROOT/chat-ui"
sudo cp -rf "$AIBOX_HERMES_DIR/chat-ui/." "$WEB_ROOT/chat-ui/"
sudo chown -R "root:$CADDY_USER" "$WEB_ROOT"
sudo find "$WEB_ROOT/chat-ui" -type d -exec chmod 755 {} \;
sudo find "$WEB_ROOT/chat-ui" -type f -exec chmod 644 {} \;
echo "  UI -> $WEB_ROOT/chat-ui (+ PWA + vendor)"

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

# 2) roles.json : SOURCE DE VÉRITÉ UNIQUE des rôles (éditable via l'UI admin).
#    Construite AVANT les tokens : on préserve les rôles existants, on ajoute les
#    nouveaux users (admin si listé dans AIBOX_ADMINS, sinon client). Un re-run SANS
#    AIBOX_ADMINS ne dégrade donc JAMAIS un admin existant en client.
python3 - "$AIBOX_ROOT/roles.json" "${AIBOX_ADMINS:-}" "$WEBUI_DIR" <<'PY'
import json, os, sys, glob
rf, admins, webuidir = sys.argv[1], sys.argv[2], sys.argv[3]
roles = {}
if os.path.exists(rf):
    try: roles = json.load(open(rf, encoding="utf-8"))
    except Exception: roles = {}
admin_set = {a for a in admins.split(",") if a}
# users = webui/*.env (source de vérité, cohérente avec setup-portal.sh)
for envf in glob.glob(os.path.join(webuidir, "*.env")):
    u = os.path.basename(envf)[:-4]
    if u not in roles:
        roles[u] = "admin" if u in admin_set else "client"
json.dump(roles, open(rf, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("  roles ->", rf, roles)
PY

# 2bis) Token par user : chaque dash env DOIT avoir HERMES_DASHBOARD_SESSION_TOKEN
#       (sinon le dashboard en génère un aléatoire au démarrage = /api/ws en 403).
#       Le rôle écrit dans le token = celui de roles.json → cohérent avec /me, jamais
#       divergent (c'est ce repli que lit le plugin brand si /me est indispo).
sudo mkdir -p "$WEB_ROOT/chat-tokens"
# nullglob (posé en tête) : si aucun webui/*.env, la boucle ne s'exécute pas et le
# glob ne reste pas littéral → pas de $envf inexistant, pas d'exit 1 sous set -e.
for envf in "$WEBUI_DIR"/*.env; do
  [ -e "$envf" ] || continue
  u="$(basename "$envf" .env)"
  if ! grep -q '^HERMES_DASHBOARD_SESSION_TOKEN=' "$envf"; then
    echo "HERMES_DASHBOARD_SESSION_TOKEN=aibox-$(openssl rand -hex 13)" >> "$envf"
    echo "  + token généré pour $u -> restart aibox-webui@$u"
    # La stack live est aibox-webui@ (hermes-webui), plus aibox-dash@. On restart le
    # bon service pour qu'il relise l'env (nouveau token).
    systemctl is-enabled "aibox-webui@$u" >/dev/null 2>&1 && sudo systemctl restart "aibox-webui@$u" || true
  fi
  t="$(grep -oP '^HERMES_DASHBOARD_SESSION_TOKEN=\K.*' "$envf" || true)"
  role="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],'client'))" "$AIBOX_ROOT/roles.json" "$u" 2>/dev/null || echo client)"
  printf '{"token":"%s","role":"%s"}\n' "$t" "$role" | sudo tee "$WEB_ROOT/chat-tokens/$u.json" >/dev/null
done
sudo chown -R "root:$CADDY_USER" "$WEB_ROOT/chat-tokens"
sudo chmod 750 "$WEB_ROOT/chat-tokens"
# chmod 640 des *.json SEULEMENT s'il en existe : sans garde, le glob non résolu
# (répertoire vide) passait un littéral à chmod → exit 1 sous set -e, TUANT le
# pipeline AVANT la config Authentik. La boucle glob (nullglob) est sûre par nature.
for f in "$WEB_ROOT/chat-tokens/"*.json; do [ -e "$f" ] && sudo chmod 640 "$f"; done
echo "  tokens -> $WEB_ROOT/chat-tokens (rôle = roles.json, lisibles par groupe $CADDY_USER)"

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
