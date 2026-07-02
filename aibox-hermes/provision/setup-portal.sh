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
# Racine du repo BoxIA (= parent de aibox-hermes/) : sert à substituer __AIBOX_REPO__
# dans les units (chemin de l'extension white-label). Pas forcément ~/BoxIA.
AIBOX_REPO_DIR="$(cd "$AIBOX_HERMES_DIR/.." && pwd)"
OWNER="${AIBOX_OWNER:-clikinfo}"
# Home réel de l'owner (getent → robuste même si owner ≠ /home/owner). Sert à
# substituer __OWNER_HOME__ dans les units systemd (plus de /home/clikinfo en dur).
OWNER_HOME="$( { getent passwd "$OWNER" 2>/dev/null || true; } | cut -d: -f6)"; OWNER_HOME="${OWNER_HOME:-/home/$OWNER}"
AIBOX_ROOT="${AIBOX_ROOT:-$OWNER_HOME/aibox}"
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

# 1) Interface web hermes-webui PRIVÉE par user : env (HERMES_HOME + port) + service
#    Remplace l'ancien dashboard Hermes + chat-ui maison. Langue = français.
#    L'extension white-label « AI Box » est injectée par le service (repo, update-safe).
WEBUI_DIR="$AIBOX_ROOT/webui"
run "mkdir -p '$WEBUI_DIR'"
# Le unit est un GABARIT (__AIBOX_OWNER__/__OWNER_HOME__/__AIBOX_REPO__) : on
# substitue à l'installation les chemins RÉELS (owner, home, repo) → plus aucun
# /home/clikinfo ni ~/BoxIA en dur ; l'extension white-label n'est plus en 404
# quand owner ≠ clikinfo ou repo ≠ ~/BoxIA. En dry-run on montre la commande sed.
if [ "$CHECK" = 1 ]; then
  echo "    [check] sed __AIBOX_OWNER__=$OWNER __OWNER_HOME__=$OWNER_HOME __AIBOX_REPO__=$AIBOX_REPO_DIR -> /etc/systemd/system/aibox-webui@.service"
else
  sed -e "s#__AIBOX_OWNER__#$OWNER#g" -e "s#__OWNER_HOME__#$OWNER_HOME#g" -e "s#__AIBOX_REPO__#$AIBOX_REPO_DIR#g" \
    "$AIBOX_HERMES_DIR/provision/aibox-webui@.service" > /etc/systemd/system/aibox-webui@.service
  chmod 644 /etc/systemd/system/aibox-webui@.service
fi
run "systemctl daemon-reload"

# Attribution des ports STABLE (un user garde SON port). Sinon, ajouter un
# employé décale les ports par ordre alphabétique → le Caddyfile route un user
# vers le webui d'un AUTRE (fuite cross-user : HERMES_HOME/historique/mémoire).
# 1re passe : on relit le port déjà attribué dans l'env existant.
BASE_PORT=9130
declare -A UPORT=()
used=" "
for u in "${USERS[@]}"; do
  p="$(grep -oP '^HERMES_WEBUI_PORT=\K[0-9]+' "$WEBUI_DIR/$u.env" 2>/dev/null || true)"
  if [ -n "$p" ]; then UPORT["$u"]="$p"; used="$used$p "; fi
done
# 2e passe : les nouveaux users prennent le prochain port libre.
next=$BASE_PORT
for u in "${USERS[@]}"; do
  [ -n "${UPORT[$u]:-}" ] && continue
  while [[ "$used" == *" $next "* ]]; do next=$((next+1)); done
  UPORT["$u"]="$next"; used="$used$next "
done

for u in "${USERS[@]}"; do
  envf="$WEBUI_DIR/$u.env"; hh="$USERS_DIR/$u/hermes"; port="${UPORT[$u]}"
  if [ "$CHECK" = 1 ]; then
    echo "    [check] écrire $envf (HERMES_HOME=$hh, HERMES_WEBUI_PORT=$port) + langue fr"
  else
    # Rôle : admin (tout) si listé dans AIBOX_ADMINS, sinon client (chat focalisé).
    # Passé à l'extension via le query-string du script → droits par rôle.
    role="client"; case ",${AIBOX_ADMINS:-}," in *",$u,"*) role="admin";; esac
    { echo "HERMES_HOME=$hh"; echo "HERMES_WEBUI_PORT=$port";
      echo "HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/aibox.js?role=$role"; } > "$envf"
    chown "$OWNER:$OWNER" "$envf"
    # Langue par défaut = français (réglage du state webui, par user)
    mkdir -p "$hh/webui"
    python3 -c "import json,os,sys;p=sys.argv[1];d=json.load(open(p,encoding='utf-8')) if os.path.exists(p) else {};d['language']='fr';json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)" "$hh/webui/settings.json" 2>/dev/null || true
    chown -R "$OWNER:$OWNER" "$hh/webui"
  fi
  # enable PUIS restart inconditionnel : sur un service déjà actif, `enable --now`
  # renvoie 0 et NE relit PAS l'env modifié → l'ancien port reste actif. On force
  # donc le restart pour que HERMES_WEBUI_PORT (nouvel env) soit bien pris en compte.
  run "systemctl enable 'aibox-webui@$u' >/dev/null 2>&1 || true"
  run "systemctl restart 'aibox-webui@$u' || true"
  echo "  webui $u -> :$port (fr)"
done

# 2) Caddy :443 (Authentik forward_auth + map user->backend + routes web) -------
# Le map réutilise le port RÉEL attribué à chaque user (UPORT), pas un 9130+i
# positionnel — sinon le routage diverge de l'env réel des services.
gen_map() { for u in "${USERS[@]}"; do echo "				$u 127.0.0.1:${UPORT[$u]}"; done; }
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
			# hermes-webui sert l'app à la racine (/) → pas de redirect /chat.
			# (white-label AI Box + langue FR injectés côté service.)
			# --- AIBOX-DOCS-BEGIN ---
			redir /aibox-docs /aibox-docs/
			handle_path /aibox-docs/* {
				root * $WEB_ROOT/docs
				file_server
			}
			# --- AIBOX-DOCS-END ---
			map {http.request.header.X-Authentik-Username} {backend} {
$(gen_map)
				# default : un user authentifié SANS webui (ex. akadmin, admin
				# Authentik) tombait sur {backend} vide → reverse_proxy 502 après
				# login. On le route vers le 1er webui pour éviter le 502.
				default 127.0.0.1:${UPORT[${USERS[0]}]}
			}
			reverse_proxy {backend}
		}
	}
}
http://$AIBOX_HOST {
	redir https://$AIBOX_HOST{uri}
}
# Authentik (login) derrière Caddy → certificat Caddy (approuvé), zéro avertissement.
https://$AIBOX_HOST:$AUTHENTIK_PORT {
	tls internal
	reverse_proxy http://127.0.0.1:9000 {
		header_up Host {host}
		header_up X-Forwarded-Proto https
	}
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
  # HERMES_DOCS pointe vers le home de l'owner (Hermes y est installé, pas dans /root).
  # On passe WEBUI_DIR explicitement : install-web-chat en fait sa source de vérité users.
  AIBOX_ROOT="$AIBOX_ROOT" WEB_ROOT="$WEB_ROOT" WEBUI_DIR="$WEBUI_DIR" AIBOX_ADMINS="${AIBOX_ADMINS:-}" \
    HERMES_DOCS="$OWNER_HOME/hermes-agent/website/docs" bash "$AIBOX_HERMES_DIR/provision/install-web-chat.sh"
  # Config Authentik AVEC RETRY : juste après le déploiement, les migrations/flows
  # peuvent ne pas être prêts (le health-check /-/health/ready ne le garantit pas).
  if docker ps --format '{{.Names}}' | grep -q "^$AK_CONTAINER$"; then
    ak_ok=0
    for i in $(seq 1 8); do
      out="$(docker exec -e AIBOX_HOST="$AIBOX_HOST" -e AIBOX_AUTHENTIK_PORT="$AUTHENTIK_PORT" \
                -e AIBOX_USER_PASSWORD="$USER_PASSWORD" -e AIBOX_USERS="$(IFS=,; echo "${USERS[*]}")" \
                -i "$AK_CONTAINER" ak shell < "$AIBOX_HERMES_DIR/provision/authentik/setup-authentik.py" 2>&1)"
      if printf '%s' "$out" | grep -q 'AIBOX-AUTHENTIK CHANGED'; then
        echo "  Authentik: $(printf '%s' "$out" | grep 'AIBOX-AUTHENTIK CHANGED')"; ak_ok=1; break
      fi
      echo "  Authentik pas encore prêt (tentative $i/8)…"; sleep 10
    done
    [ "$ak_ok" = 1 ] || echo "  ! Authentik non configuré après 8 essais — relancer provision/authentik/setup-authentik.py"
  else
    echo "  ! conteneur Authentik '$AK_CONTAINER' absent — config Authentik non appliquée"
  fi
fi
echo "== portail prêt : https://$AIBOX_HOST/  (chat en page d'accueil) =="
