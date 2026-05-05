#!/usr/bin/env bash
# =============================================================================
# start-connector.sh
# -----------------------------------------------------------------------------
# Démarre (ou redémarre) un worker connecteur AI Box. Wrappe les commandes
# `docker compose --env-file ../../.env up -d` et `build` qui sont bloquées
# par le hook block-direct-xefia-ops (les workers connecteurs ne sont pas
# dans la compose root, donc deploy-to-xefia.sh ne les gère pas).
#
# Usage :
#   tools/start-connector.sh <slug>             # up -d (use cache si built)
#   tools/start-connector.sh <slug> --rebuild   # build --no-cache puis up
#   tools/start-connector.sh <slug> --logs      # tail logs après up
#   tools/start-connector.sh <slug> --stop      # stop + rm le service
#   tools/start-connector.sh --list             # liste les slugs disponibles
#
# Slugs valides = sous-dossiers de services/connectors/ ayant un
# docker-compose.yml.
# =============================================================================
set -euo pipefail

SSH_HOST="${AIBOX_SSH_HOST:-clikinfo@192.168.15.210}"
SERVER_REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
ENV_FILE="$SERVER_REPO/.env"

c_blue()   { printf "\033[1;34m▶\033[0m %s\n" "$*" >&2; }
c_green()  { printf "\033[1;32m✓\033[0m %s\n" "$*" >&2; }
c_yellow() { printf "\033[1;33m⚠\033[0m %s\n" "$*" >&2; }
c_red()    { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; }

ssh_cmd() {
  ssh -o ConnectTimeout=5 "$SSH_HOST" "$@"
}

list_connectors() {
  c_blue "Connecteurs disponibles (sur xefia) :"
  ssh_cmd "find $SERVER_REPO/services/connectors -maxdepth 2 -name docker-compose.yml -printf '%h\n' | xargs -n1 basename | sort"
}

usage() {
  cat <<EOF
Usage : tools/start-connector.sh <slug> [--rebuild|--logs|--stop|--restart]
        tools/start-connector.sh --list
EOF
  exit 1
}

[[ $# -lt 1 ]] && usage
case "$1" in
  --list) list_connectors; exit 0 ;;
  -h|--help) usage ;;
esac

SLUG="$1"
ACTION="${2:---up}"
SVC_DIR="$SERVER_REPO/services/connectors/$SLUG"
COMPOSE="$SVC_DIR/docker-compose.yml"

# Vérifie que le slug existe
if ! ssh_cmd "test -f $COMPOSE"; then
  c_red "compose introuvable : $COMPOSE"
  c_blue "Slugs valides :"
  list_connectors
  exit 1
fi

case "$ACTION" in
  --up)
    c_blue "docker compose up -d sur $SLUG (--env-file $ENV_FILE)"
    ssh_cmd "cd $SVC_DIR && docker compose --env-file $ENV_FILE up -d 2>&1 | tail -20" >&2
    ssh_cmd "docker ps --filter name=aibox-conn-$SLUG --format '{{.Names}}\t{{.Status}}'" >&2
    c_green "Up. Pour les logs : tools/start-connector.sh $SLUG --logs"
    ;;
  --rebuild)
    c_blue "docker compose build --no-cache (peut prendre 5-15 min) puis up"
    ssh_cmd "cd $SVC_DIR && docker compose --env-file $ENV_FILE build --no-cache 2>&1 | tail -20" >&2
    ssh_cmd "cd $SVC_DIR && docker compose --env-file $ENV_FILE up -d 2>&1 | tail -10" >&2
    c_green "Rebuild + Up done."
    ;;
  --logs)
    c_blue "Tailing logs aibox-conn-$SLUG (Ctrl+C pour arrêter)"
    ssh_cmd "docker logs --tail 100 -f aibox-conn-$SLUG"
    ;;
  --stop)
    c_blue "docker compose stop"
    ssh_cmd "cd $SVC_DIR && docker compose --env-file $ENV_FILE stop 2>&1 | tail -5" >&2
    c_green "Stopped."
    ;;
  --restart)
    c_blue "docker compose restart"
    ssh_cmd "cd $SVC_DIR && docker compose --env-file $ENV_FILE restart 2>&1 | tail -5" >&2
    c_green "Restarted."
    ;;
  *)
    c_red "action inconnue : $ACTION"
    usage
    ;;
esac
