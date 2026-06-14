#!/usr/bin/env bash
# =============================================================================
# Monte le PORTAIL WEB multi-utilisateur AI Box, de façon REPRODUCTIBLE.
# Idempotent : rejouable après un wipe. Génère tout ce qui avait été fait à la
# main : dashboards privés par user (+ tokens), Caddy :443 (Authentik forward_auth
# + routage par user + routes /aibox-chat & /aibox-docs), contenu web, et la
# config Authentik (provider/app/outpost/marque/users).
#
# Pré-requis : Hermes + wizards déjà passés (un HERMES_HOME par user existe),
#              Authentik up (conteneur), Caddy installé.
#
# Usage : sudo -E setup-portal.sh
# Env :
#   AIBOX_ROOT      (def /home/<owner>/aibox)
#   AIBOX_OWNER     (def clikinfo)        utilisateur système qui héberge
#   COMPANY         (def demo)
#   AIBOX_USERS     (def = dossiers users existants)  csv "andre,marc"
#   AIBOX_HOST      (def 192.168.15.210)  IP/domaine du portail
#   AUTHENTIK_PORT  (def 9443)
#   AK_CONTAINER    (def authentik-server-1)
#   USER_PASSWORD   (def 1234)
#   WEB_ROOT        (def /opt/aibox-web)
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OWNER="${AIBOX_OWNER:-clikinfo}"
AIBOX_ROOT="${AIBOX_ROOT:-/home/$OWNER/aibox}"
COMPANY="${COMPANY:-demo}"
AIBOX_HOST="${AIBOX_HOST:-192.168.15.210}"
AUTHENTIK_PORT="${AUTHENTIK_PORT:-9443}"
AK_CONTAINER="${AK_CONTAINER:-authentik-server-1}"
USER_PASSWORD="${USER_PASSWORD:-1234}"
WEB_ROOT="${WEB_ROOT:-/opt/aibox-web}"
USERS_DIR="$AIBOX_ROOT/companies/$COMPANY/users"
DASH_DIR="$AIBOX_ROOT/dash"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
# En dry-run, on génère le Caddyfile dans /tmp (jamais d'écrasement du live).
if [ "$CHECK" = 1 ]; then CADDYFILE="/tmp/aibox-Caddyfile.check"; else CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"; fi
run() { if [ "$CHECK" = 1 ]; then echo "    [check] $*"; else eval "$@"; fi; }

# Liste des users = explicite ou dossiers existants
if [ -n "${AIBOX_USERS:-}" ]; then IFS=',' read -ra USERS <<< "$AIBOX_USERS"
else USERS=(); for d in "$USERS_DIR"/*/; do [ -d "$d" ] && USERS+=("$(basename "$d")"); done; fi
[ ${#USERS[@]} -eq 0 ] && { echo "Aucun utilisateur (lance d'abord les wizards)."; exit 1; }
echo "== setup-portal : host=$AIBOX_HOST, users=${USERS[*]} =="

# 1) Dashboard privé par user : env (HERMES_HOME + port + token) + service ------
run "mkdir -p '$DASH_DIR'"
run "install -m 644 '$AIBOX_HERMES_DIR/provision/aibox-dash@.service' /etc/systemd/system/aibox-dash@.service"
run "systemctl daemon-reload"
port=9120
for u in "${USERS[@]}"; do
  envf="$DASH_DIR/$u.env"; hh="$USERS_DIR/$u/hermes"
  if [ "$CHECK" = 1 ]; then
    echo "    [check] écrire $envf (HERMES_HOME=$hh, DASH_PORT=$port, token généré)"
  elif [ ! -f "$envf" ]; then
    { echo "HERMES_HOME=$hh"; echo "DASH_PORT=$port";
      echo "HERMES_DASHBOARD_SESSION_TOKEN=aibox-$(openssl rand -hex 13)"; } > "$envf"
    chown "$OWNER:$OWNER" "$envf"
  else
    grep -q '^HERMES_DASHBOARD_SESSION_TOKEN=' "$envf" || echo "HERMES_DASHBOARD_SESSION_TOKEN=aibox-$(openssl rand -hex 13)" >> "$envf"
    grep -q '^DASH_PORT=' "$envf" || echo "DASH_PORT=$port" >> "$envf"
  fi
  run "systemctl enable --now 'aibox-dash@$u' >/dev/null 2>&1 || systemctl restart 'aibox-dash@$u' || true"
  echo "  dashboard $u -> :$port"
  port=$((port+1))
done

# 2) Caddy :443 (Authentik forward_auth + map user->backend + routes web) -------
gen_map() { for i in "${!USERS[@]}"; do echo "				${USERS[$i]} 127.0.0.1:$((9120+i))"; done; }
{
cat <<EOF
# Généré par setup-portal.sh — ne pas éditer à la main.
https://$AIBOX_HOST {
	tls internal
	handle /outpost.goauthentik.io/* {
		reverse_proxy http://127.0.0.1:9000
	}
	handle {
		route {
			forward_auth http://127.0.0.1:9000 {
				uri /outpost.goauthentik.io/auth/caddy
				copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid
				header_up Host {http.request.host}
				header_up X-Forwarded-Proto https
				trusted_proxies private_ranges
			}
			# Page d'accueil = le chat épuré (override /chat) plutôt que /sessions
			@root path /
			redir @root /chat
			# --- AIBOX-CHAT-BEGIN ---
			handle /aibox-chat/session {
				root * $WEB_ROOT/chat-tokens
				rewrite * /{http.request.header.X-Authentik-Username}.json
				header Cache-Control no-store
				file_server
			}
			redir /aibox-chat /aibox-chat/
			handle_path /aibox-chat/* {
				root * $WEB_ROOT/chat-ui
				file_server
			}
			# --- AIBOX-CHAT-END ---
			# --- AIBOX-DOCS-BEGIN ---
			redir /aibox-docs /aibox-docs/
			handle_path /aibox-docs/* {
				root * $WEB_ROOT/docs
				file_server
			}
			# --- AIBOX-DOCS-END ---
			map {http.request.header.X-Authentik-Username} {backend} {
$(gen_map)
			}
			reverse_proxy {backend}
		}
	}
}
http://$AIBOX_HOST {
	redir https://$AIBOX_HOST{uri}
}
EOF
} > "$CADDYFILE"
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 && echo "  Caddyfile généré + validé ($CADDYFILE)" || { echo "  ! Caddyfile invalide"; exit 1; }
run "systemctl reload caddy 2>/dev/null || systemctl restart caddy"

# 3) Contenu web (chat-ui + docs + tokens) + config Authentik -------------------
if [ "$CHECK" = 1 ]; then
  echo "    [check] install-web-chat.sh (chat-ui + docs + tokens)"
  echo "    [check] docker exec $AK_CONTAINER ak shell < setup-authentik.py (provider/app/outpost/marque/users)"
else
  AIBOX_ROOT="$AIBOX_ROOT" WEB_ROOT="$WEB_ROOT" bash "$AIBOX_HERMES_DIR/provision/install-web-chat.sh"
  if docker ps --format '{{.Names}}' | grep -q "^$AK_CONTAINER$"; then
    docker exec -e AIBOX_HOST="$AIBOX_HOST" -e AIBOX_AUTHENTIK_PORT="$AUTHENTIK_PORT" \
                -e AIBOX_USER_PASSWORD="$USER_PASSWORD" -e AIBOX_USERS="$(IFS=,; echo "${USERS[*]}")" \
                -i "$AK_CONTAINER" ak shell < "$AIBOX_HERMES_DIR/provision/authentik/setup-authentik.py" 2>/dev/null | grep -i CHANGED || true
  else
    echo "  ! conteneur Authentik '$AK_CONTAINER' absent — config Authentik non appliquée"
  fi
fi
echo "== portail prêt : https://$AIBOX_HOST/  (chat en page d'accueil) =="
