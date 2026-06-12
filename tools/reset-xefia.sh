#!/usr/bin/env bash
# =============================================================================
# reset-xefia.sh
# -----------------------------------------------------------------------------
# Wrapper conforme CLAUDE.md règle 1 pour reset complet de la box xefia.
#
# Au lieu de lancer ./reset-as-client.sh en SSH direct (interdit), ce script :
#   - acquiert le lock /srv/ai-stack/.deploy.lock (évite collision avec un
#     déploiement en cours)
#   - vérifie que la branche cible est pushée et à jour côté origin
#   - tag git « pre-reset-<branche>-<timestamp> » côté serveur (rollback)
#   - sync /srv/ai-stack sur la branche cible AVANT le reset (pour que le
#     wizard utilise la dernière version de sso_provisioning.py et donc les
#     pre-prompts V2 consolidés directement, sans dépendre des migrations
#     post-reset)
#   - lance ./reset-as-client.sh --yes
#   - affiche l'URL du wizard de setup et le rappel des étapes suivantes
#
# Le user doit ensuite :
#   1. Aller sur http://192.168.15.210:8090, suivre le wizard
#   2. Une fois le wizard fini, lancer tools/deploy-to-xefia.sh <branche>
#      pour rejouer les migrations DB sur les apps fraîchement créées
#
# Usage :
#   tools/reset-xefia.sh <branche>          # confirmation interactive
#   tools/reset-xefia.sh <branche> --yes    # bypass confirmation
#   tools/reset-xefia.sh --status           # affiche le lock
#
# Pré-requis :
#   - Branche existante côté origin (push fait)
#   - Accès SSH clikinfo@192.168.15.210 par clé
#   - Modèles Ollama préservés (~10 GB), volumes Docker applicatifs SUPPRIMÉS
# =============================================================================
set -euo pipefail

SSH_HOST="${AIBOX_SSH_HOST:-clikinfo@192.168.15.210}"
SERVER_REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
LOCK_FILE="$SERVER_REPO/.deploy.lock"
LOCK_TTL_MIN=30   # plus long que deploy car le reset est plus long

SESSION_ID="${USER:-claude}-$(hostname)-$$"
TS=$(date +%s)

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ssh_cmd() { ssh -o ConnectTimeout=10 "$SSH_HOST" "$@"; }

cmd_status() {
  log "Lock status sur xefia :"
  if ssh_cmd "test -f $LOCK_FILE" 2>/dev/null; then
    ssh_cmd "cat $LOCK_FILE"
  else
    ok "Aucun lock actif"
  fi
}

acquire_lock() {
  log "Tentative d'acquisition du lock (reset:$BRANCH)"
  local lock_content
  lock_content="session=$SESSION_ID action=reset branch=$BRANCH ts=$TS ttl_min=$LOCK_TTL_MIN"
  # Atomique : succès si le fichier n'existe pas, échec sinon. Avec TTL 30 min.
  if ssh_cmd "set -e
    if [ -f $LOCK_FILE ]; then
      ts=\$(awk -F'ts=' '{print \$2}' $LOCK_FILE | awk '{print \$1}')
      now=\$(date +%s)
      age=\$((now - ts))
      ttl=\$((${LOCK_TTL_MIN} * 60))
      if [ \$age -lt \$ttl ]; then
        echo \"lock active (age \${age}s < TTL \${ttl}s)\" >&2
        cat $LOCK_FILE >&2
        exit 1
      fi
      echo 'old lock expired, taking over' >&2
    fi
    echo '$lock_content' > $LOCK_FILE
  "; then
    ok "Lock acquis"
  else
    fail "Lock indisponible. Utilise --status pour voir qui le tient."
  fi
}

release_lock() {
  ssh_cmd "rm -f $LOCK_FILE" 2>/dev/null || true
  ok "Lock libéré"
}

# -- Main entry ------------------------------------------------------------

ARGS=()
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --status) cmd_status; exit 0 ;;
    --yes|-y) ASSUME_YES=true ;;
    *) ARGS+=("$arg") ;;
  esac
done

if [[ ${#ARGS[@]} -lt 1 ]]; then
  sed -n '4,30p' "$0" >&2
  exit 64
fi

BRANCH="${ARGS[0]}"

# 1. Vérifier que la branche existe sur origin
log "=== Reset complet xefia → branche '$BRANCH' ==="
log "Session : $SESSION_ID"
log "Vérification que la branche est pushée"
if ! git ls-remote --heads origin "$BRANCH" | grep -q "$BRANCH"; then
  fail "La branche '$BRANCH' n'existe pas sur origin (push manquant ?)"
fi
ok "Branche présente sur origin"

# 2. Confirmation explicite (action très destructive)
if [[ "$ASSUME_YES" != "true" ]]; then
  cat >&2 <<EOF

\033[1;31m════════════════════════════════════════════════════════════════════\033[0m
\033[1;31m  ⚠ RESET COMPLET DE LA BOX XEFIA\033[0m
\033[1;31m════════════════════════════════════════════════════════════════════\033[0m

Cela va :
  • Tag de backup git : pre-reset-${BRANCH//\//-}-${TS}
  • Sync /srv/ai-stack/ sur '$BRANCH' (git fetch + reset --hard)
  • Lancer ./reset-as-client.sh --yes :
    • Stop tous les containers applicatifs (Authentik, Dify, Qdrant,
      n8n, Open WebUI, Langfuse, Edge Caddy, connecteurs, …)
    • Supprime les volumes data (comptes Authentik, agents Dify,
      vectors Qdrant, workflows n8n, monitors Uptime Kuma, …)
    • Préserve modèles Ollama (~10 GB), code source, backups
  • Démarre le wizard de setup sur :8090

\033[1;33mPour confirmer, tape exactement : RESET-FULL\033[0m
EOF
  read -rp "> " answer
  if [[ "$answer" != "RESET-FULL" ]]; then
    warn "Annulé"
    exit 1
  fi
fi

acquire_lock
trap 'release_lock' EXIT

# 3. Tag de backup avant tout
TAG="pre-reset-${BRANCH//\//-}-$TS"
log "Tag de backup git : $TAG"
ssh_cmd "cd $SERVER_REPO && git tag -f $TAG HEAD" || warn "Tag échec (continue)"

# 4. Sync sur la branche cible
log "Sync /srv/ai-stack/ sur '$BRANCH' (fetch + reset --hard)"
ssh_cmd "cd $SERVER_REPO && git fetch --prune origin && git checkout '$BRANCH' && git reset --hard origin/'$BRANCH'" \
  || fail "git checkout/reset échec"
ok "Working tree sync sur $BRANCH"

# 5. Reset
log "Lance ./reset-as-client.sh --yes (peut prendre 1-3 min)"
ssh_cmd "cd $SERVER_REPO && ./reset-as-client.sh --yes" \
  || fail "reset-as-client.sh a échoué (voir logs ci-dessus)"

# 6. Smoke check wizard up
sleep 4
log "Vérification que le wizard de setup répond"
SETUP_PORT="${SETUP_PORT:-8090}"
if curl -fsS --max-time 10 "http://192.168.15.210:${SETUP_PORT}/" >/dev/null 2>&1; then
  ok "Wizard up sur port $SETUP_PORT"
else
  warn "Wizard ne répond pas encore (peut nécessiter quelques secondes de plus)"
fi

# 7. Instructions pour la suite
cat >&2 <<EOF

\033[1;32m════════════════════════════════════════════════════════════════════\033[0m
\033[1;32m  ✓ Reset terminé — la box est en mode 'premier démarrage'\033[0m
\033[1;32m════════════════════════════════════════════════════════════════════\033[0m

\033[1;36mProchaines étapes :\033[0m

  1. \033[1;33mWizard de setup (interactif, ~5 min)\033[0m :
     Va sur http://192.168.15.210:${SETUP_PORT}/
     Suis les écrans (création admin, validation, install agents).
     Le wizard utilisera sso_provisioning.py de la branche '$BRANCH'
     (pre-prompts V2 consolidés appliqués dès la création des apps).

  2. \033[1;33mUne fois le wizard terminé\033[0m, repasse côté Windows et lance :
     \033[1;37mtools/deploy-to-xefia.sh '$BRANCH'\033[0m
     → rebuild aibox-app + smoke test + rejoue les migrations DB
       (0002-0012 idempotentes, beaucoup seront marquées « déjà
       appliquées » car le pre-prompt V2 contient déjà les markers).

  3. \033[1;33mSmoke test final\033[0m : login sur http://192.168.15.210:3100/
     puis vérifier /bench (cloud BYOK à reconfigurer si nécessaire).

\033[1;36mRollback en cas de pépin\033[0m :
  ssh $SSH_HOST "cd $SERVER_REPO && git reset --hard $TAG"
  (mais ça ne ramènera pas les volumes Docker supprimés — backups
   /srv/aibox-backups/ peuvent aider partiellement)

EOF
