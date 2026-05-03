#!/usr/bin/env bash
# Installe le service systemd aibox-update-watcher.service sur xefia.
# Idempotent : à relancer après chaque mise à jour de update-watcher.sh sans
# casser l'instance en cours (Restart=on-failure).
#
# Usage : sudo bash tools/install-update-watcher.sh
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Lancer en sudo (modifie /etc/systemd/system/)" >&2
  exit 1
fi

REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
SRC="$REPO/tools/aibox-update-watcher.service"
DST="/etc/systemd/system/aibox-update-watcher.service"

if [[ ! -f "$SRC" ]]; then
  echo "Source absent : $SRC" >&2
  exit 1
fi

cp "$SRC" "$DST"
systemctl daemon-reload
systemctl enable aibox-update-watcher.service
systemctl restart aibox-update-watcher.service

echo "✓ Service installé et démarré."
echo "  status : systemctl status aibox-update-watcher"
echo "  logs   : journalctl -u aibox-update-watcher -f"
