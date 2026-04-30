#!/usr/bin/env bash
# =============================================================================
# Publie les alias mDNS d'AI Box.
# =============================================================================
# Le hostname réel du serveur est publié automatiquement par avahi-daemon
# (ex: xefia.local). Ce script ajoute des A-records mDNS pour :
#   aibox.local
#   auth.aibox.local, agents.aibox.local, flows.aibox.local,
#   chat.aibox.local, admin.aibox.local, status.aibox.local,
#   qdrant.aibox.local
#
# Détecte automatiquement l'IP LAN du serveur (route par défaut) ou
# utilise $AIBOX_LAN_IP si défini.
#
# Démarré par aibox-mdns-aliases.service. Reste en foreground (les
# A-records publiés via avahi-publish disparaissent quand le process
# meurt).
# =============================================================================

set -euo pipefail

ALIASES=(
  "aibox.local"
  "auth.aibox.local"
  "agents.aibox.local"
  "flows.aibox.local"
  "chat.aibox.local"
  "admin.aibox.local"
  "status.aibox.local"
  "qdrant.aibox.local"
)

# Détecte l'IP LAN par défaut (interface qui sort par défaut).
# Évite les bridges Docker (172.x) et docker_gwbridge.
if [[ -z "${AIBOX_LAN_IP:-}" ]]; then
  AIBOX_LAN_IP="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
fi

if [[ -z "$AIBOX_LAN_IP" ]]; then
  echo "ERROR: impossible de détecter l'IP LAN. Définir AIBOX_LAN_IP=x.y.z.w" >&2
  exit 1
fi

echo "Publication mDNS sur $AIBOX_LAN_IP pour : ${ALIASES[*]}"

PIDS=()
cleanup() {
  echo "Stop : kill ${PIDS[*]}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT TERM INT

for alias in "${ALIASES[@]}"; do
  # -a : address record, -R : allow override (réannonce si le nom existe déjà)
  /usr/bin/avahi-publish -a -R "$alias" "$AIBOX_LAN_IP" &
  PIDS+=($!)
done

# Si l'un meurt → quitte (systemd restart)
wait -n
exit $?
