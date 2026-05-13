#!/usr/bin/env bash
# aibox-host/restore.sh — restaure une AI Box depuis un backup tar.gz
#
# Usage :
#   sudo aibox-host/restore.sh <backup.tar.gz>
#
# Pré-requis : Docker + stack BoxIA déjà installés (au moins les images pullées
# et les DB containers présents — ils seront stoppés puis re-démarrés).
#
# Idempotent : la restauration efface les volumes existants avant restore.
# ⚠ ATTENTION : opération destructive sur l'état courant. Confirmation requise.
set -euo pipefail

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Restore exige root"

SRC="${1:-}"
[ -n "$SRC" ] || fail "Usage : sudo $0 <backup.tar.gz>"
[ -f "$SRC" ] || fail "Backup absent : $SRC"

echo ""
echo "⚠  ATTENTION : la restauration va EFFACER l'état courant et le remplacer par $SRC"
echo "    - Volumes BoxIA (/srv/xefia, /srv/ai-stack/data)"
echo "    - Config Hermes (/opt/aibox/hermes)"
echo "    - DB Postgres (Authentik, Dify, langfuse)"
echo ""
if [ -t 0 ]; then
  read -r -p "Confirmer (taper RESTORE en majuscules) : " CONFIRM
  [ "$CONFIRM" = "RESTORE" ] || fail "Annulé"
else
  warn "Mode non-interactif : confirmation auto. Set DRY_RUN=1 pour annuler."
  [ "${DRY_RUN:-0}" = "0" ] || fail "DRY_RUN=1 — restore annulé"
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

log "[1/5] Extraction backup → $TMPDIR"
tar xzf "$SRC" -C "$TMPDIR"
[ -d "$TMPDIR/data" ] || fail "Backup malformé : pas de data/ dans le tarball"
ok "Backup extrait"

log "[2/5] Stop containers"
for container in aibox-hermes aibox-authentik-db aibox-dify-db aibox-langfuse-db; do
  docker stop "$container" 2>/dev/null && ok "Stop $container" || warn "$container déjà stop ou absent"
done

log "[3/5] Restore volumes data"
for archive in "$TMPDIR/data"/*.tar.gz; do
  [ -f "$archive" ] || continue
  TARGET_BASE=$(basename "$archive" .tar.gz)
  case "$TARGET_BASE" in
    xefia)     TARGET=/srv/xefia ;;
    data)      TARGET=/srv/ai-stack/data ;;
    *)         warn "Archive inconnue : $archive — skip"; continue ;;
  esac
  log "  Restore $archive → $TARGET"
  rm -rf "$TARGET" 2>/dev/null || true
  mkdir -p "$(dirname "$TARGET")"
  tar xzf "$archive" -C "$(dirname "$TARGET")"
  ok "  $TARGET restauré"
done

log "[4/5] Restore configs"
if [ -d "$TMPDIR/configs/hermes" ]; then
  rm -rf /opt/aibox/hermes
  mkdir -p /opt/aibox
  cp -a "$TMPDIR/configs/hermes" /opt/aibox/hermes
  ok "/opt/aibox/hermes restauré"
fi
[ -f "$TMPDIR/configs/boxia.env" ] && cp "$TMPDIR/configs/boxia.env" /srv/ai-stack/.env && ok "/srv/ai-stack/.env restauré"

log "[5/5] Re-démarrage containers + restore DB"
for container in aibox-authentik-db aibox-dify-db aibox-langfuse-db; do
  docker start "$container" 2>/dev/null && ok "Start $container" || warn "$container absent"
done
sleep 8  # attente DB ready

# Restore dumps SQL (drops + re-create depuis dump)
for sql in "$TMPDIR/db"/*.sql; do
  [ -f "$sql" ] || continue
  CONT=$(basename "$sql" .sql)
  if docker ps --format '{{.Names}}' | grep -q "^${CONT}$"; then
    log "  Restore $sql → $CONT"
    docker exec -i "$CONT" psql -U postgres < "$sql" 2>&1 | tail -3
  fi
done

# Re-up Hermes
docker start aibox-hermes 2>/dev/null && ok "Hermes redémarré" || warn "Hermes pas redémarré"

echo ""
ok "Restore complet. Vérifier :"
echo "  docker ps                    # tous les containers up ?"
echo "  docker exec aibox-hermes /opt/hermes/.venv/bin/hermes doctor"
echo "  curl http://localhost:9119/health"
