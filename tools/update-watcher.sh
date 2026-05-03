#!/usr/bin/env bash
# =============================================================================
# update-watcher.sh
# -----------------------------------------------------------------------------
# Daemon léger qui surveille le flag /srv/ai-stack/data/.update-requested écrit
# par /api/system/update (UI Paramètres → bouton « Mettre à jour »), puis lance
# tools/deploy-to-xefia.sh <branche> et publie la progression dans
# /srv/ai-stack/data/.update-status.
#
# Pourquoi ce détour : le container aibox-app n'a pas le pouvoir de redémarrer
# son host (pas de docker.sock RW, pas de l'arbo /srv/ai-stack, pas de git).
# Ce watcher tourne côté hôte sous l'utilisateur clikinfo (qui peut sudo et
# accéder au socket docker). C'est volontairement asymétrique.
#
# Lancement : systemd user service tools/aibox-update-watcher.service
#             (ou en interactif pour debug : tools/update-watcher.sh)
# =============================================================================
set -euo pipefail

REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
DATA_DIR="$REPO/data"
FLAG="$DATA_DIR/.update-requested"
STATUS="$DATA_DIR/.update-status"
LOG_FILE="$DATA_DIR/update-watcher.log"
DEPLOY_LOG="$DATA_DIR/last-deploy.log"
POLL_SEC=5

mkdir -p "$DATA_DIR"
touch "$LOG_FILE"
log() { printf '%s [watcher] %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG_FILE" >&2; }

# Écrit un status JSON. Cap log_tail à ~50 lignes / 10 KB pour ne pas charger
# l'UI inutilement.
write_status() {
  local state="$1" step="$2" message="$3" extra_json="${4:-}"
  local tail_json="[]"
  if [[ -f "$DEPLOY_LOG" ]]; then
    # Extrait les 50 dernières lignes, strip ANSI, JSON-encode chaque ligne
    tail_json=$(tail -n 50 "$DEPLOY_LOG" \
      | sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' \
      | python3 -c 'import json,sys; print(json.dumps([l.rstrip() for l in sys.stdin if l.strip()]))' 2>/dev/null \
      || echo "[]")
  fi
  python3 - "$state" "$step" "$message" "$tail_json" "$extra_json" "$STATUS" <<'PY'
import json, sys, os, datetime
state, step, message, tail, extra, path = sys.argv[1:7]
out = {"state": state, "step": step, "message": message}
try:
    out["log_tail"] = json.loads(tail)
except Exception:
    out["log_tail"] = []
if extra.strip():
    try:
        out.update(json.loads(extra))
    except Exception:
        pass
out["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

run_deploy() {
  local branch="$1" requested_at="$2" requested_by="$3"
  local extra=$(printf '{"branch":"%s","requested_at":"%s","requested_by":"%s","started_at":"%s"}' \
    "$branch" "$requested_at" "$requested_by" "$(date -Iseconds)")
  write_status "running" "starting" "Démarrage du déploiement…" "$extra"

  # On lance deploy-to-xefia.sh en redirigeant tout vers DEPLOY_LOG.
  # Le watcher continue de poller le log et écrit le step courant.
  : >"$DEPLOY_LOG"
  (
    cd "$REPO"
    bash tools/deploy-to-xefia.sh "$branch" 2>&1
  ) >>"$DEPLOY_LOG" &
  local deploy_pid=$!

  # Pendant que le déploiement tourne, on extrait le step courant en parsant
  # les marqueurs ▶ du script.
  while kill -0 "$deploy_pid" 2>/dev/null; do
    if [[ -f "$DEPLOY_LOG" ]]; then
      local last_step
      last_step=$(grep -oP '▶ \K.*' "$DEPLOY_LOG" 2>/dev/null | tail -1 | sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' || echo "")
      if [[ -n "$last_step" ]]; then
        write_status "running" "$(echo "$last_step" | head -c 60)" "$last_step" "$extra"
      fi
    fi
    sleep 2
  done
  wait "$deploy_pid" || true
  local rc=$?

  local finished_at
  finished_at=$(date -Iseconds)
  local extra_done="${extra%\}},\"finished_at\":\"$finished_at\",\"exit_code\":$rc}"
  if [[ "$rc" -eq 0 ]]; then
    write_status "done" "smoke_test_ok" "Déploiement terminé ($branch)" "$extra_done"
    log "deploy OK rc=$rc branch=$branch"
  else
    write_status "failed" "deploy_failed" "Le déploiement a échoué (voir log_tail)" "$extra_done"
    log "deploy FAIL rc=$rc branch=$branch"
  fi
}

log "watcher started, polling $FLAG every ${POLL_SEC}s"
while true; do
  if [[ -f "$FLAG" ]]; then
    log "flag detected: $FLAG"
    # Parse les champs requis du flag (format : JSON {requested_at, requested_by, branch})
    local_branch=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("branch","main"))' "$FLAG" 2>/dev/null || echo "main")
    local_req_at=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("requested_at",""))' "$FLAG" 2>/dev/null || echo "")
    local_req_by=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("requested_by",""))' "$FLAG" 2>/dev/null || echo "")
    # Consomme le flag avant de lancer pour éviter de rejouer en boucle si
    # le déploiement crash et laisse le flag.
    rm -f "$FLAG"
    run_deploy "$local_branch" "$local_req_at" "$local_req_by"
  fi
  sleep "$POLL_SEC"
done
