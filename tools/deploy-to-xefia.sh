#!/usr/bin/env bash
# =============================================================================
# deploy-to-xefia.sh
# -----------------------------------------------------------------------------
# Pipeline standard de déploiement aibox-app vers le serveur xefia.
#
# RÈGLE PRODUIT : tout déploiement passe par ce script.
# Plus jamais d'edit/scp/cp direct sur /srv/ai-stack/services/.
# Plus jamais de docker compose lancé à la main sans lock.
#
# Usage :
#   tools/deploy-to-xefia.sh <branche>             # déploie cette branche
#   tools/deploy-to-xefia.sh --rollback            # rollback au dernier tag pre-deploy-*
#   tools/deploy-to-xefia.sh --rollback --yes      # rollback sans confirmation
#   tools/deploy-to-xefia.sh --status              # affiche le lock + dernier deploy
#
# Pré-requis :
#   - Branche déjà commitée et pushée vers origin
#   - Accès SSH clikinfo@192.168.15.210 par clé
#
# Mécaniques :
#   - Lock fichier sur xefia (1 déploiement à la fois, auto-release après 30 min)
#   - Tag de backup pre-deploy-<branche>-<timestamp> (pour rollback)
#   - Reset hard sur origin/<branche> (pas de merge, pas de stash, pas d'ambiguïté)
#   - Build + restart juste aibox-app (pas les 33 autres containers)
#   - Re-joue les migrations DB si tools/migrations/ contient du nouveau
#   - Smoke test /healthz avant de libérer le lock
#   - Append au log /srv/ai-stack/data/deploys.log
# =============================================================================
set -euo pipefail

# ---- Config ---------------------------------------------------------------
SSH_HOST="${AIBOX_SSH_HOST:-clikinfo@192.168.15.210}"
SERVER_REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
LOCK_FILE="$SERVER_REPO/.deploy.lock"
DEPLOY_LOG="$SERVER_REPO/data/deploys.log"
LOCK_TTL_MIN=30  # builds + migrations peuvent dépasser 10 min — TTL large
COMPOSE_FILE="services/app/docker-compose.yml"
ENV_FILE="$SERVER_REPO/.env"  # CRITIQUE : compose -f sans --env-file cherche
                              # le .env dans le dir du compose (services/app/)
                              # qui n'existe pas → vars vides → app cassée
SERVICE_NAME="app"  # nom du service dans services/app/docker-compose.yml
CONTAINER_NAME="aibox-app"
HEALTH_PATH="/"
HEALTH_PORT="3100"  # port externe (Next.js en network_mode: host sur APP_PORT=3100)

SESSION_ID="${USER:-claude}-$(hostname)-$$"
TS=$(date +%s)
ASSUME_YES=false  # --yes : saute les confirmations interactives (rollback)

# Contexte courant pour le log d'audit : renseigné par main()/cmd_rollback()
# pour que fail() puisse logger les échecs (statut FAIL) dans deploys.log.
DEPLOY_LOG_KIND=""
DEPLOY_LOG_TARGET=""

# ---- Helpers --------------------------------------------------------------
log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() {
  printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
  # Logge aussi les échecs dans deploys.log (best-effort : si SSH down,
  # on ne veut pas masquer l'erreur d'origine).
  if [[ -n "$DEPLOY_LOG_KIND" && -n "$DEPLOY_LOG_TARGET" ]]; then
    local reason
    reason=$(printf '%s' "$*" | tr -d "'\"" | head -c 120)
    log_deploy "$DEPLOY_LOG_KIND" "$DEPLOY_LOG_TARGET" "FAIL reason=\"$reason\"" 2>/dev/null || true
  fi
  exit 1
}

ssh_cmd() {
  ssh -o ConnectTimeout=10 "$SSH_HOST" "$@"
}

usage() {
  sed -n '5,30p' "$0" >&2
  exit 64
}

# ---- Sub-commands ---------------------------------------------------------
cmd_status() {
  log "Lock status sur xefia :"
  if ssh_cmd "test -f $LOCK_FILE" 2>/dev/null; then
    ssh_cmd "cat $LOCK_FILE"
  else
    ok "Aucun lock actif"
  fi
  log "Dernier déploiement :"
  ssh_cmd "tail -1 $DEPLOY_LOG 2>/dev/null || echo '(no deploy log yet)'"
}

cmd_rollback() {
  log "Recherche du dernier tag pre-deploy-* sur xefia"
  local tag
  tag=$(ssh_cmd "cd $SERVER_REPO && git tag --sort=-creatordate 'pre-deploy-*' | head -1" || true)
  if [[ -z "$tag" ]]; then
    fail "Aucun tag pre-deploy-* trouvé. Rien à rollback."
  fi
  DEPLOY_LOG_KIND="rollback"
  DEPLOY_LOG_TARGET="$tag"
  if [[ "$ASSUME_YES" == "true" ]]; then
    warn "Rollback vers $tag (--yes : pas de confirmation)"
  else
    warn "Rollback vers $tag — confirmer avec ENTER (Ctrl+C pour annuler)"
    read -r
  fi
  acquire_lock "rollback-$tag"
  trap release_lock EXIT
  ssh_cmd "cd $SERVER_REPO && git reset --hard $tag"
  rebuild_app
  smoke_test
  log_deploy "rollback" "$tag" "OK"
  ok "Rollback terminé sur $tag"
}

# ---- Lock management ------------------------------------------------------
acquire_lock() {
  local label="${1:-deploy}"
  log "Tentative d'acquisition du lock ($label)"
  # Acquisition atomique en UN SEUL aller-retour SSH :
  #   - `set -C` (noclobber) : le `>` échoue si le lock existe déjà → pas de
  #     fenêtre test-puis-écrit entre deux SSH (ancienne version racée).
  #   - Si le lock existe ET dépasse le TTL : on l'écrase (`>|` bypasse
  #     noclobber) dans la même commande distante — au mieux atomique.
  #   - Sinon : HELD + contenu du lock pour diagnostiquer qui déploie.
  local lock_content="session=$SESSION_ID label=$label ts=$TS"
  local out
  out=$(ssh_cmd "set -C
if (echo '$lock_content' > '$LOCK_FILE') 2>/dev/null; then
  echo ACQUIRED
elif [ -f '$LOCK_FILE' ] && [ \$(( ( \$(date +%s) - \$(stat -c %Y '$LOCK_FILE') ) / 60 )) -ge $LOCK_TTL_MIN ]; then
  echo '$lock_content' >| '$LOCK_FILE'
  echo ACQUIRED_STALE
else
  echo HELD
  cat '$LOCK_FILE' 2>/dev/null || true
fi")
  case "$out" in
    ACQUIRED)
      ok "Lock acquis" ;;
    *ACQUIRED_STALE*)
      warn "Lock périmé (TTL ${LOCK_TTL_MIN}min dépassé) — remplacé"
      ok "Lock acquis" ;;
    HELD*)
      printf '%s\n' "$out" | tail -n +2 >&2
      fail "Lock présent et récent (TTL ${LOCK_TTL_MIN}min). Une autre session déploie. Réessaye dans quelques minutes." ;;
    *)
      fail "Réponse inattendue à l'acquisition du lock : $out" ;;
  esac
}

release_lock() {
  # Ne supprime le lock QUE s'il nous appartient encore (une autre session a
  # pu le remplacer après expiration du TTL — on ne casse pas son lock).
  if ssh_cmd "grep -q 'session=$SESSION_ID' '$LOCK_FILE' 2>/dev/null && rm -f '$LOCK_FILE'" 2>/dev/null; then
    ok "Lock libéré"
  else
    warn "Lock non libéré (absent ou repris par une autre session)"
  fi
}

# ---- Deploy steps ---------------------------------------------------------
ensure_branch_pushed() {
  local branch="$1"
  log "Vérifie que $branch est bien pushée sur origin"
  if ! git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    fail "La branche $branch n'existe pas sur origin. Push d'abord."
  fi
  # Compare local HEAD vs remote — bloque si on déploie un truc non poussé
  local local_sha remote_sha
  local_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
  remote_sha=$(git ls-remote origin "$branch" | awk '{print $1}')
  if [[ -n "$local_sha" && "$local_sha" != "$remote_sha" ]]; then
    warn "Local HEAD ($local_sha) ≠ remote $branch ($remote_sha)"
    warn "Tu vas déployer le contenu remote, pas ton local. Continuer ? [y/N]"
    read -r ans
    [[ "$ans" == "y" ]] || fail "Annulé"
  fi
  ok "Branche pushée OK"
}

create_backup_tag() {
  local branch="$1"
  local short
  short=$(echo "$branch" | tr '/' '-')
  local tag="pre-deploy-${short}-${TS}"
  log "Tag de backup : $tag"
  ssh_cmd "cd $SERVER_REPO && git tag '$tag'"
  echo "$tag"
}

reset_to_branch() {
  local branch="$1"
  log "git fetch + reset --hard origin/$branch sur xefia"
  # GITHUB_TOKEN local (env du watcher ou shell dev) → passé via STDIN, jamais
  # interpolé dans la ligne de commande SSH (sinon visible dans `ps` côté
  # serveur). Le credential.helper distant référence \$GITHUB_TOKEN (env, pas
  # de valeur dans l'argv). Priorité : .env serveur > token stdin. Sans token :
  # git fetch reste anonyme (OK pour repo public). Indispensable si le repo
  # Tobaz34/BoxIA passe privé.
  printf '%s\n' "${GITHUB_TOKEN:-}" | ssh_cmd "IFS= read -r GH_TOKEN_STDIN
cd $SERVER_REPO || exit 1
if [ -f $ENV_FILE ]; then set -a; . $ENV_FILE; set +a; fi
export GITHUB_TOKEN=\"\${GITHUB_TOKEN:-\$GH_TOKEN_STDIN}\"
if [ -n \"\$GITHUB_TOKEN\" ]; then
  git -c credential.helper='!f() { sleep 0.1; echo username=x-access-token; echo \"password=\$GITHUB_TOKEN\"; }; f' fetch origin --quiet || exit 1
else
  git fetch origin --quiet || exit 1
fi
git reset --hard origin/$branch" \
    | tail -3 >&2
  ok "Working tree synchronisé"
}

rebuild_app() {
  log "docker compose build + up $SERVICE_NAME (image rebuild peut prendre 3-5 min)"
  # --env-file CRITIQUE : sinon vars NEXTAUTH_SECRET/AUTHENTIK_* sont vides
  # côté container et l'auth crash avec NO_SECRET. Vu en prod 2026-05-03.
  # On exporte aussi BUILD_COMMIT_* depuis git pour que le Dockerfile (via
  # docker-compose.yml args) génère un public/version.json complet — sinon
  # /api/system/check-updates ne peut pas comparer au tip de main.
  # tail -10 du build pour voir les éventuelles erreurs (TS, npm install).
  # set -o pipefail côté DISTANT : sans lui, `build | tail` renvoie le code
  # de tail (0) et un build cassé passait inaperçu → on déployait du vide.
  ssh_cmd "set -o pipefail; cd $SERVER_REPO && \
    export BUILD_COMMIT_SHA=\$(git rev-parse HEAD) && \
    export BUILD_COMMIT_DATE=\$(git log -1 --format=%cI) && \
    export BUILD_COMMIT_MESSAGE=\$(git log -1 --format=%s | head -c 200) && \
    export BUILD_BRANCH=\$(git rev-parse --abbrev-ref HEAD) && \
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build $SERVICE_NAME 2>&1 | tail -10" >&2
  ssh_cmd "set -o pipefail; cd $SERVER_REPO && docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d $SERVICE_NAME 2>&1 | tail -3" >&2
  ok "Container redémarré"
}

run_pending_migrations() {
  # Positionne MIGRATIONS_FAILED=1 si le runner échoue (consommé par main()
  # pour logger OK_MIGRATIONS_FAILED au lieu de OK dans deploys.log).
  MIGRATIONS_FAILED=0
  if ssh_cmd "test -d $SERVER_REPO/tools/migrations"; then
    log "Re-joue les migrations DB pendantes (tools/migrations/run-pending.py)"
    # NB: test -f, pas -x — git check-out à 100644 (pas de bit exec), on
    # invoque toujours via python3 explicite donc c'est ok.
    # ENV_FILE chargé pour ADMIN_EMAIL/PASSWORD/etc. requis par les migrations.
    # DIFY_CONSOLE_API forcé sur localhost:8081 (nginx mappé) car
    # aibox-dify-api:5001 n'est pas résolvable depuis le host xefia (DNS
    # interne docker uniquement).
    if ssh_cmd "test -f $SERVER_REPO/tools/migrations/run-pending.py"; then
      ssh_cmd "cd $SERVER_REPO && set -a && . $ENV_FILE && set +a && DIFY_CONSOLE_API=\${DIFY_CONSOLE_API:-http://localhost:8081/console/api} python3 tools/migrations/run-pending.py" >&2 \
        || { warn "Migrations ont échoué — investiguer"; MIGRATIONS_FAILED=1; }
    else
      warn "tools/migrations/ existe mais run-pending.py absent — skip"
    fi
  fi
}

smoke_test() {
  log "Smoke test : attente du healthcheck sur port $HEALTH_PORT"
  local i code
  for i in 1 2 3 4 5 6 7 8 9 10; do
    # Next.js + middleware NextAuth → / renvoie 307 redirect vers /api/auth/signin
    # quand pas authentifié. C'est OK : ça prouve que le serveur tourne.
    code=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' http://localhost:$HEALTH_PORT$HEALTH_PATH" 2>/dev/null || echo "000")
    if echo "$code" | grep -qE '^(200|204|307|308)$'; then
      ok "Smoke test OK (HTTP $code sur $HEALTH_PATH)"
      return 0
    fi
    sleep 3
  done
  fail "Smoke test failed après 30s — container peut-être crashé. Voir 'docker logs $CONTAINER_NAME'"
}

log_deploy() {
  local kind="$1" target="$2" result="$3"
  ssh_cmd "mkdir -p $(dirname $DEPLOY_LOG) && echo '$(date -Iseconds) kind=$kind target=$target session=$SESSION_ID result=$result' >> $DEPLOY_LOG"
}

# ---- Main -----------------------------------------------------------------
main() {
  # Extrait le flag --yes (position libre) avant de router les sous-commandes.
  local arg args=()
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) ASSUME_YES=true ;;
      *)        args+=("$arg") ;;
    esac
  done
  set -- "${args[@]+"${args[@]}"}"

  case "${1:-}" in
    --status|status)     cmd_status; exit 0 ;;
    --rollback|rollback) cmd_rollback; exit 0 ;;
    -h|--help|"")        usage ;;
  esac

  local branch="$1"
  log "=== Déploiement de la branche '$branch' vers xefia ==="
  log "Session : $SESSION_ID"
  DEPLOY_LOG_KIND="deploy"
  DEPLOY_LOG_TARGET="$branch"

  ensure_branch_pushed "$branch"
  acquire_lock "deploy:$branch"
  trap release_lock EXIT

  local backup_tag
  backup_tag=$(create_backup_tag "$branch")
  log "Pour rollback manuel : tools/deploy-to-xefia.sh --rollback (ou git reset --hard $backup_tag)"

  reset_to_branch "$branch"
  recreate_top_level_if_changed
  rebuild_app
  run_pending_migrations
  smoke_test

  local result="OK"
  if [[ "${MIGRATIONS_FAILED:-0}" -eq 1 ]]; then
    result="OK_MIGRATIONS_FAILED"
  fi
  log_deploy "deploy" "$branch" "$result"
  ok "Déploiement terminé ($result). Backup tag : $backup_tag"
}

# Si le docker-compose.yml top-level (Qdrant + autres services partagés) a
# changé dans le pull qu'on vient de faire, on re-up les services concernés
# pour appliquer les nouvelles options (ex: ulimits sur Qdrant).
# Idempotent : si rien n'a changé, `docker compose up -d` ne fait rien.
recreate_top_level_if_changed() {
  log "Vérification des services top-level (Qdrant…) après git reset"
  ssh_cmd "cd $SERVER_REPO && \
    [ -f $ENV_FILE ] && set -a && . $ENV_FILE && set +a; \
    docker compose --env-file $ENV_FILE up -d 2>&1 | tail -5" >&2
  ok "Services top-level synchronisés"

  # Dify : re-up uniquement le SSRF proxy si on a touché à sa config (la
  # whitelist /etc/squid/conf.d/allow-boxia.conf a un volume mount, donc
  # la recreate prend en compte le nouveau fichier). On évite de re-up
  # toute la stack Dify (api, web, db, …) qui ferait planter les
  # conversations en cours.
  log "Re-up dify-ssrf-proxy si squid-allow-boxia.conf changé"
  ssh_cmd "cd $SERVER_REPO/services/dify && \
    [ -f $ENV_FILE ] && set -a && . $ENV_FILE && set +a; \
    docker compose --env-file $ENV_FILE up -d --no-deps --force-recreate dify-ssrf-proxy 2>&1 | tail -3" >&2
  ok "dify-ssrf-proxy synchronisé"
}

main "$@"
