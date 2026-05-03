#!/usr/bin/env bash
# =============================================================================
# update-watcher.sh
# -----------------------------------------------------------------------------
# Daemon léger qui surveille le flag /data/.update-requested écrit par
# /api/system/update (UI Paramètres → bouton « Mettre à jour »), puis lance
# tools/deploy-to-xefia.sh <branche> et publie la progression dans
# /data/.update-status.
#
# Pourquoi ce détour : le container aibox-app n'a pas le pouvoir de redémarrer
# son host (pas de docker.sock RW, pas de l'arbo /srv/ai-stack, pas de git).
# Ce watcher tourne côté hôte (clikinfo, group docker) et passe par
# `docker exec aibox-app` pour lire/écrire les fichiers /data, parce que ce
# volume est owned par UID 1001 (next user du container) et clikinfo n'est
# pas dans le group microk8s qui le possède côté host. Le routage docker
# évite de devoir chown/chmod en sudo.
#
# Lancement : systemd user service tools/aibox-update-watcher.service
#             (ou en interactif pour debug : tools/update-watcher.sh)
# =============================================================================
set -euo pipefail

REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
ENV_FILE="$REPO/.env"
APP_CONTAINER="${AIBOX_APP_CONTAINER:-aibox-app}"
APP_USER_UID="${AIBOX_APP_UID:-1001}"
# Logs du watcher : sortent dans le journal systemd (StandardOutput=journal),
# pas besoin de fichier disque dans /data (dont on n'a pas write).
log() { printf '%s [watcher] %s\n' "$(date -Iseconds)" "$*" >&2; }

POLL_SEC=5
FLAG_PATH_IN_CONTAINER="/data/.update-requested"
STATUS_PATH_IN_CONTAINER="/data/.update-status"
RUNTIME_TOKEN_PATH_IN_CONTAINER="/data/.github-token-runtime"

# Pour le DEPLOY_LOG on garde un fichier disque côté host (clikinfo home),
# car deploy-to-xefia.sh doit pouvoir y rediriger sa sortie sans passer par
# docker exec (sinon on perd le streaming).
DEPLOY_LOG="${HOME:-/home/clikinfo}/.aibox-deploy.log"

docker_read_file() {
  local path="$1"
  docker exec "$APP_CONTAINER" cat "$path" 2>/dev/null || true
}

docker_write_file() {
  local path="$1" content="$2"
  printf '%s' "$content" \
    | docker exec -i -u "$APP_USER_UID" "$APP_CONTAINER" tee "$path" >/dev/null
}

docker_remove_file() {
  local path="$1"
  docker exec -u "$APP_USER_UID" "$APP_CONTAINER" rm -f "$path" || true
}

docker_test_file() {
  local path="$1"
  docker exec "$APP_CONTAINER" test -f "$path"
}

# Charge GITHUB_TOKEN en cascade :
#   1. .env (provisioning master, lisible par clikinfo)
#   2. /data/.github-token-runtime via docker exec (saisie UI)
load_github_token() {
  unset GITHUB_TOKEN
  # Pipefail + set -e + grep qui ne matche rien (token absent de .env) =
  # script die silencieusement. `|| true` à la fin du pipe pour absorber
  # le code retour quand GITHUB_TOKEN n'est pas dans .env (cas standard
  # quand l'admin a saisi via l'UI).
  if [[ -r "$ENV_FILE" ]]; then
    GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true)
  fi
  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    GITHUB_TOKEN=$(docker_read_file "$RUNTIME_TOKEN_PATH_IN_CONTAINER" || true)
  fi
  export GITHUB_TOKEN
}

# Génère le JSON de status et l'écrit dans le container.
# Cap log_tail à ~50 lignes pour ne pas charger l'UI.
write_status() {
  local state="$1" step="$2" message="$3" extra_json="${4:-}"
  local tail_json="[]"
  if [[ -f "$DEPLOY_LOG" ]]; then
    tail_json=$(tail -n 50 "$DEPLOY_LOG" \
      | sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' \
      | python3 -c 'import json,sys; print(json.dumps([l.rstrip() for l in sys.stdin if l.strip()]))' 2>/dev/null \
      || echo "[]")
  fi
  local content
  content=$(python3 - "$state" "$step" "$message" "$tail_json" "$extra_json" <<'PY'
import json, sys, datetime
state, step, message, tail, extra = sys.argv[1:6]
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
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
)
  docker_write_file "$STATUS_PATH_IN_CONTAINER" "$content"
}

run_deploy() {
  local branch="$1" requested_at="$2" requested_by="$3"
  local extra=$(printf '{"branch":"%s","requested_at":"%s","requested_by":"%s","started_at":"%s"}' \
    "$branch" "$requested_at" "$requested_by" "$(date -Iseconds)")
  write_status "running" "starting" "Démarrage du déploiement…" "$extra"

  load_github_token
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

# Pré-flight : aibox-app doit être up sinon docker exec va échouer en boucle.
log "watcher started, polling $FLAG_PATH_IN_CONTAINER (via docker exec) every ${POLL_SEC}s"
log "deploy log: $DEPLOY_LOG"
while ! docker exec "$APP_CONTAINER" true 2>/dev/null; do
  log "container $APP_CONTAINER not yet ready, waiting…"
  sleep 5
done

while true; do
  if docker_test_file "$FLAG_PATH_IN_CONTAINER"; then
    log "flag detected: $FLAG_PATH_IN_CONTAINER"
    local_flag=$(docker_read_file "$FLAG_PATH_IN_CONTAINER")
    local_branch=$(printf '%s' "$local_flag" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("branch","main"))' 2>/dev/null || echo "main")
    local_req_at=$(printf '%s' "$local_flag" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("requested_at",""))' 2>/dev/null || echo "")
    local_req_by=$(printf '%s' "$local_flag" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("requested_by",""))' 2>/dev/null || echo "")
    docker_remove_file "$FLAG_PATH_IN_CONTAINER"
    run_deploy "$local_branch" "$local_req_at" "$local_req_by"
  fi
  sleep "$POLL_SEC"
done
