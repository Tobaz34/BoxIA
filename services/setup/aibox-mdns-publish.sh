#!/usr/bin/env bash
# =============================================================================
# Publie les alias mDNS d'AI Box.
# =============================================================================
# Le hostname réel du serveur est publié automatiquement par avahi-daemon
# (ex: xefia.local). Ce script ajoute des CNAME-équivalents pour :
#   aibox.local
#   auth.aibox.local
#   agents.aibox.local
#   flows.aibox.local
#   chat.aibox.local
#   admin.aibox.local
#   status.aibox.local
#   qdrant.aibox.local
#
# Démarré par aibox-mdns-aliases.service et tourne en boucle (les CNAME
# avahi-publish-cname expirent quand le process meurt).
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

# Lance avahi-publish-cname en arrière-plan pour chaque alias.
# Les pids sont tués par le trap si le service est stoppé.
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT TERM INT

for alias in "${ALIASES[@]}"; do
  /usr/bin/avahi-publish-cname "$alias" &
  PIDS+=($!)
done

# Wait : si l'un des avahi-publish meurt, on quitte (systemd restartera)
wait -n
exit $?
