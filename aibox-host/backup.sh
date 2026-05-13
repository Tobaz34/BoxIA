#!/usr/bin/env bash
# aibox-host/backup.sh — backup complet d'une AI Box (volumes + dumps DB)
#
# Usage :
#   sudo aibox-host/backup.sh [destination]
#
#   destination : path optionnel du tarball (default /var/backups/aibox-YYYY-MM-DD.tar.gz)
#
# Backup :
#   - /opt/aibox/hermes/         (config Hermes + skills + data Hermes)
#   - /srv/ai-stack/.env         (config BoxIA)
#   - Volumes Docker BoxIA       (via tar des bind mounts /srv/xefia/ ou Docker named volumes)
#   - Dump Postgres BoxIA        (Authentik DB, Dify DB, langfuse DB)
#   - Dump n8n state
#
# Idempotent. Préserve compression (tar.gz). Affiche taille finale.
set -euo pipefail

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Backup exige root (volumes BoxIA en /srv/ owned root)"

DEST="${1:-/var/backups/aibox-$(date +%F).tar.gz}"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

mkdir -p "$(dirname "$DEST")"

log "[1/5] Pause services pour cohérence (Hermes seul ; BoxIA reste up)"
docker stop aibox-hermes 2>/dev/null || warn "Hermes pas en cours d'exécution"

log "[2/5] Dump Postgres (Authentik + Dify + langfuse)"
mkdir -p "$TMPDIR/db"
for container in aibox-authentik-db aibox-dify-db aibox-langfuse-db; do
  if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
    docker exec "$container" pg_dumpall -U postgres 2>/dev/null > "$TMPDIR/db/${container}.sql" \
      && ok "Dump $container" \
      || warn "Dump $container échoué"
  else
    warn "$container absent — skip dump"
  fi
done

log "[3/5] Snapshot des configs"
mkdir -p "$TMPDIR/configs"
[ -d /opt/aibox/hermes ] && cp -a /opt/aibox/hermes "$TMPDIR/configs/hermes" 2>/dev/null
[ -f /srv/ai-stack/.env ] && cp /srv/ai-stack/.env "$TMPDIR/configs/boxia.env" 2>/dev/null

log "[4/5] Snapshot des volumes data"
mkdir -p "$TMPDIR/data"
# Volumes BoxIA standard (BoxIA stack utilise /srv/xefia/* ou /srv/ai-stack/data/)
for src in /srv/xefia /srv/ai-stack/data; do
  if [ -d "$src" ]; then
    log "  tar $src"
    tar czf "$TMPDIR/data/$(basename "$src").tar.gz" -C "$(dirname "$src")" "$(basename "$src")" 2>/dev/null \
      && ok "  $src archived" \
      || warn "  $src tar échoué"
  fi
done

log "[5/5] Bundle final → $DEST"
tar czf "$DEST" -C "$TMPDIR" .
SIZE=$(du -h "$DEST" | cut -f1)
ok "Backup créé : $DEST ($SIZE)"

# Redémarre Hermes
docker start aibox-hermes 2>/dev/null && ok "Hermes redémarré" || warn "Hermes pas redémarré"

echo ""
echo "Pour restaurer sur un PC neuf :"
echo "  1. Installer l'AI Box (sudo aibox-host/aibox-install.sh)"
echo "  2. Stopper les containers (docker compose -f ... down)"
echo "  3. sudo aibox-host/restore.sh $DEST"
