#!/usr/bin/env bash
# =============================================================================
# AI Box — Backup avant opération risquée
# =============================================================================
# Snapshot tous les volumes critiques dans /srv/aibox-backups/<timestamp>/
# Crée un tar.gz par volume + un manifeste.
#
# Usage:
#   ./backup.sh                    # backup standard
#   ./backup.sh quick              # rapide : snapshot Qdrant + dumps DB only
#   ./backup.sh restore <stamp>    # restore depuis un backup donné
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- Volumes critiques à protéger ------------------------------------------
# Mode `full` = tous les volumes ci-dessous.
# Mode `quick` = uniquement les DBs et configs (skip les modèles Ollama et OWUI).
CRITICAL_VOLUMES_FULL=(
  "anythingllm_ollama_data"           # Modèles Ollama (15+ GB) — gros, skipped en quick
  "anythingllm_open-webui"            # Données Open WebUI (chats, RAG)
  "anythingllm_n8n_data"              # Workflows n8n
  "aibox_qdrant_data"                 # Vector store
  "aibox_qdrant_snapshots"
  "aibox-authentik_authentik_postgres_data"
  "aibox-authentik_authentik_media"
  "aibox-dify_dify_db_data"
  "aibox-dify_dify_api_storage"
  "anythingllm_anythingllm_storage"
  "anythingllm_npm_data"
  "anythingllm_npm_letsencrypt"
  "anythingllm_portainer_data"
)
# Mode quick = ne backup QUE ce qui est petit et critique (DBs + configs)
CRITICAL_VOLUMES_QUICK=(
  "aibox-authentik_authentik_postgres_data"
  "aibox-dify_dify_db_data"
  "anythingllm_n8n_data"
  "anythingllm_npm_data"
  "anythingllm_npm_letsencrypt"
  "anythingllm_portainer_data"
)

# ---- Args ------------------------------------------------------------------
MODE="${1:-full}"
RESTORE_STAMP="${2:-}"
BACKUP_ROOT="/srv/aibox-backups"

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }

# ---- Restore mode ----------------------------------------------------------
if [[ "$MODE" == "restore" ]]; then
  if [[ -z "$RESTORE_STAMP" ]]; then
    c_red "Usage: $0 restore <YYYY-mm-dd_HH-MM-SS>"
    ls -1 "$BACKUP_ROOT" 2>/dev/null | tail -10
    exit 1
  fi
  SRC="$BACKUP_ROOT/$RESTORE_STAMP"
  [[ -d "$SRC" ]] || { c_red "Pas de backup à $SRC"; exit 1; }
  c_yellow "⚠ Restore depuis $SRC — tous les containers utilisant ces volumes vont être STOPPÉS."
  read -rp "Continuer ? [yes/no] : " ans
  [[ "$ans" == "yes" ]] || exit 0
  for archive in "$SRC"/*.tar.gz; do
    vol=$(basename "$archive" .tar.gz)
    c_blue "  → Restore $vol"
    docker run --rm -v "$vol":/data -v "$SRC":/backup alpine \
      sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -xzf /backup/$vol.tar.gz -C /data"
  done
  c_green "Restore terminé. Pense à relancer les services."
  exit 0
fi

# ---- Backup mode -----------------------------------------------------------
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

c_blue "════════════════════════════════════════════════════════════"
c_blue "  AI Box — Backup [$MODE] — $STAMP"
c_blue "  Destination : $DEST"
c_blue "════════════════════════════════════════════════════════════"

# Manifeste de ce qui tourne (utile pour restore)
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "$DEST/containers.txt"
docker volume ls > "$DEST/volumes.txt"
docker network ls > "$DEST/networks.txt"

# Choix de la liste selon le mode
if [[ "$MODE" == "quick" ]]; then
    VOL_LIST=("${CRITICAL_VOLUMES_QUICK[@]}")
    c_yellow "  Mode QUICK — backup limité aux DBs et configs (modèles Ollama et chats OWUI ignorés)"
else
    VOL_LIST=("${CRITICAL_VOLUMES_FULL[@]}")
fi

TOTAL=0; OK=0; SKIP=0; FAIL=0
for vol in "${VOL_LIST[@]}"; do
  TOTAL=$((TOTAL+1))
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    c_yellow "  ⊘ $vol — n'existe pas, skip"
    SKIP=$((SKIP+1))
    continue
  fi
  c_blue "  → $vol"
  if docker run --rm -v "$vol":/data -v "$DEST":/backup alpine \
       tar -czf "/backup/$vol.tar.gz" -C /data . 2>/dev/null; then
    SIZE=$(du -h "$DEST/$vol.tar.gz" | cut -f1)
    c_green "    ✓ $SIZE"
    OK=$((OK+1))
  else
    c_red "    ✗ échec"
    FAIL=$((FAIL+1))
  fi
done

# Hash + manifeste
( cd "$DEST" && sha256sum *.tar.gz > SHA256SUMS 2>/dev/null || true )

c_blue "════════════════════════════════════════════════════════════"
c_green "  Total : $TOTAL | OK : $OK | Skip : $SKIP | Échec : $FAIL"
c_green "  → $DEST"
c_blue "════════════════════════════════════════════════════════════"

# Conserver les 7 derniers backups, supprimer les autres
KEEP=7
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +"$((KEEP+1))" | while read old; do
  c_yellow "  ⌫ purge $old"
  rm -rf "$old"
done
