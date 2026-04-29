#!/usr/bin/env bash
# =============================================================================
# AI Box — Auto-updater (cron quotidien)
# =============================================================================
# Vérifie les nouvelles releases sur GitHub et applique selon une politique :
#   - "stable" : applique uniquement les tags vX.Y.Z stables (pas de pre-release)
#   - "patch"  : applique uniquement les patches (vX.Y.Z où X.Y inchangé)
#   - "manual" : ne fait rien d'auto, notifie seulement
#
# Configuration via /etc/aibox/updater.conf :
#   POLICY=stable
#   MIN_HOURS_BETWEEN_UPDATES=24
#   NOTIFY_WEBHOOK=https://hooks.slack.com/...   (optionnel)
#
# Usage cron :
#   0 4 * * 1 root /srv/ai-stack/scripts/aibox-updater.sh
# =============================================================================
set -euo pipefail

# ---- Config par défaut --------------------------------------------------
REPO_DIR="${AIBOX_REPO_DIR:-/srv/ai-stack}"
CONFIG_FILE="/etc/aibox/updater.conf"
STATE_FILE="/var/lib/aibox/last_update"

POLICY="stable"
MIN_HOURS_BETWEEN_UPDATES=24
NOTIFY_WEBHOOK=""

# Charge la conf si présente
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

# ---- Helpers ------------------------------------------------------------
log() { echo "[$(date -Iseconds)] $*"; }

notify() {
    local message="$1"
    [[ -z "$NOTIFY_WEBHOOK" ]] && return
    curl -s -X POST -H 'Content-Type: application/json' \
         -d "{\"text\":\"$(hostname): $message\"}" \
         "$NOTIFY_WEBHOOK" >/dev/null 2>&1 || true
}

cooldown_ok() {
    [[ ! -f "$STATE_FILE" ]] && return 0
    local last=$(cat "$STATE_FILE")
    local now=$(date +%s)
    local elapsed=$(( (now - last) / 3600 ))
    [[ $elapsed -ge $MIN_HOURS_BETWEEN_UPDATES ]]
}

# ---- Main --------------------------------------------------------------
cd "$REPO_DIR"

# 1. Récupère les nouveaux tags du remote
log "Fetch des tags remote…"
git fetch --tags --quiet

# 2. Tag actuellement déployé
CURRENT=$(git describe --tags --exact-match 2>/dev/null || echo "untagged")
log "Version actuelle : $CURRENT"

# 3. Dernier tag stable (vX.Y.Z, pas de pre-release alpha/beta/rc)
LATEST=$(git tag --list 'v*.*.*' --sort=-v:refname | grep -vE 'alpha|beta|rc|pre' | head -1)
[[ -z "$LATEST" ]] && { log "Aucun tag stable trouvé. Sortie."; exit 0; }
log "Dernier stable : $LATEST"

# 4. Politique d'application
if [[ "$CURRENT" == "$LATEST" ]]; then
    log "Déjà à jour ($CURRENT). Sortie."
    exit 0
fi

case "$POLICY" in
    manual)
        notify "Mise à jour disponible : $CURRENT → $LATEST. Action manuelle requise."
        log "Politique manual : notification envoyée, pas d'action."
        exit 0
        ;;
    patch)
        # N'applique que si X.Y est identique entre courant et latest
        cur_xy=$(echo "$CURRENT" | sed -E 's/^v([0-9]+\.[0-9]+).*/\1/')
        new_xy=$(echo "$LATEST"  | sed -E 's/^v([0-9]+\.[0-9]+).*/\1/')
        if [[ "$cur_xy" != "$new_xy" ]]; then
            notify "Maj minor/major disponible $CURRENT → $LATEST. Patch policy : pas appliqué."
            log "Politique patch : on n'applique que les patches X.Y.Z->X.Y.Z+. Sortie."
            exit 0
        fi
        ;;
    stable)
        # OK on applique
        ;;
    *)
        log "Politique inconnue : $POLICY"
        exit 1
        ;;
esac

# 5. Cooldown anti-flapping
if ! cooldown_ok; then
    log "Cooldown actif (dernier update il y a moins de $MIN_HOURS_BETWEEN_UPDATES h). Sortie."
    exit 0
fi

# 6. Application
log "Application de $LATEST"
notify "Mise à jour démarrée : $CURRENT → $LATEST"

git checkout "$LATEST" --quiet || { notify "Échec git checkout $LATEST"; exit 1; }

if ! ./update.sh; then
    notify "❌ Échec update.sh sur $LATEST. Voir logs box."
    log "update.sh a échoué. Rollback automatique vers $CURRENT."
    git checkout "$CURRENT" --quiet
    ./update.sh || true
    exit 1
fi

date +%s > "$STATE_FILE"
log "✓ Mise à jour vers $LATEST réussie."
notify "✓ Mise à jour appliquée : $LATEST"
