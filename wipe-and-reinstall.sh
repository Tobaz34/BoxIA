#!/usr/bin/env bash
# =============================================================================
# AI Box — Wipe-and-reinstall : simulation d'un serveur neuf
# =============================================================================
# Plus radical que reset-as-client.sh : on rase TOUT (containers, volumes,
# /srv/ai-stack/, services systemd, configs avahi) puis on re-clone le repo
# et on relance install-firstrun.sh comme si la box sortait d'usine.
#
# Ce qui est PRÉSERVÉ délibérément :
#   - Modèles Ollama (volume `ollama` ou tout volume contenant 'ollama')
#     → décision utilisateur : économise 30 min de re-pull
#   - Backups historiques /srv/aibox-backups/ (préservés)
#
# Ce qui est SUPPRIMÉ :
#   - Tous les containers aibox-* + stack héritée (n8n, portainer, etc.)
#   - Tous les volumes Docker `aibox*`, `aibox-*`, `aibox_*` + volumes legacy
#     (anythingllm_*, stack_xefia_*) sauf ceux contenant "ollama"
#   - Le réseau Docker aibox_net
#   - /srv/ai-stack/ (dossier complet — un backup tarball est fait avant)
#   - /var/lib/aibox/.configured
#   - /etc/systemd/system/aibox-firstrun.service
#   - /etc/systemd/system/aibox-mdns-aliases.service
#   - /etc/avahi/services/aibox.service
#   - /usr/local/bin/aibox-mdns-publish.sh
#
# Usage :
#   ./wipe-and-reinstall.sh                # confirmation interactive
#   ./wipe-and-reinstall.sh --yes          # sans confirmation
#   ./wipe-and-reinstall.sh --dry-run      # liste ce qui serait fait, sans rien faire
#   ./wipe-and-reinstall.sh --branch main  # branche à cloner (default: main)
#
# Le script se copie automatiquement dans /tmp/ avant le wipe (sinon
# il s'auto-supprimerait avec /srv/ai-stack/). Tu peux donc le lancer
# directement depuis /srv/ai-stack/.
# =============================================================================
set -euo pipefail

REPO_URL="${AIBOX_REPO_URL:-https://github.com/Tobaz34/BoxIA.git}"
TARGET_DIR="/srv/ai-stack"
BACKUP_DIR="/srv/aibox-backups"
BRANCH="main"
ASSUME_YES=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --yes|-y)         ASSUME_YES=true ;;
        --dry-run)        DRY_RUN=true ;;
        --branch=*)       BRANCH="${arg#--branch=}" ;;
        --branch)         shift; BRANCH="${1:-main}" ;;
        --help|-h)        sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    esac
done

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
hr()       { printf "%.0s─" {1..70}; printf "\n"; }

run() {
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

# ---------------------------------------------------------------------------
# Self-copy : le script efface /srv/ai-stack/ donc se ré-exec depuis /tmp/
# ---------------------------------------------------------------------------
if [[ "${AIBOX_WIPE_SELF_COPIED:-}" != "1" && "$DRY_RUN" != "true" ]]; then
    SELF_COPY="/tmp/aibox-wipe-$(date +%s).sh"
    cp "$0" "$SELF_COPY"
    chmod +x "$SELF_COPY"
    export AIBOX_WIPE_SELF_COPIED=1
    c_blue "→ Self-copy vers $SELF_COPY (le script va survivre au wipe)"
    exec "$SELF_COPY" "$@"
fi

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
c_red "════════════════════════════════════════════════════════════════════"
c_red "  ⚠⚠⚠  WIPE COMPLET — simulation 'serveur neuf'"
c_red "════════════════════════════════════════════════════════════════════"
echo
c_yellow "Cela va RASER :"
echo "  • Tous les containers aibox-* + stack héritée (n8n, portainer, ...)"
echo "  • Tous les volumes Docker aibox* sauf ceux contenant 'ollama'"
echo "  • Le réseau Docker aibox_net"
echo "  • $TARGET_DIR (re-clone depuis GitHub ensuite)"
echo "  • Services systemd aibox-firstrun, aibox-mdns-aliases"
echo "  • Configs Avahi"
echo
c_green "PRÉSERVÉ :"
echo "  • Modèles Ollama (volumes contenant 'ollama')"
echo "  • Backups historiques $BACKUP_DIR/"
echo "  • Docker, Ubuntu, comptes user système"
echo
c_blue "Repo cible : $REPO_URL (branche $BRANCH)"
echo

if [[ "$DRY_RUN" == "true" ]]; then
    c_yellow "DRY-RUN — aucune action ne sera exécutée."
elif [[ "$ASSUME_YES" != "true" ]]; then
    read -rp "$(c_red "Continuer ? Tapez 'wipe' pour confirmer : ")" answer
    if [[ "$answer" != "wipe" ]]; then
        c_blue "Annulé."
        exit 1
    fi
fi

SUDO=""
[[ "$EUID" -ne 0 ]] && SUDO="sudo"

# ---------------------------------------------------------------------------
# [1/8] Backup tarball pré-wipe
# ---------------------------------------------------------------------------
hr
c_blue "[1/8] Backup pré-wipe de $TARGET_DIR"
TS=$(date +%Y%m%d-%H%M%S)
if [[ -d "$TARGET_DIR" ]]; then
    $SUDO mkdir -p "$BACKUP_DIR"
    BAK="$BACKUP_DIR/wipe-$TS.tar.gz"
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [dry-run] tar -czf $BAK -C / srv/ai-stack"
    else
        $SUDO tar -czf "$BAK" -C / srv/ai-stack 2>/dev/null || \
            c_yellow "  ⚠ tar partiel — on continue"
        c_green "  ✓ $BAK ($(du -h "$BAK" 2>/dev/null | cut -f1))"
    fi
else
    c_yellow "  ⊘ $TARGET_DIR n'existe pas, skip backup"
fi

# ---------------------------------------------------------------------------
# [2/8] Stop + remove containers
# ---------------------------------------------------------------------------
hr
c_blue "[2/8] Stop + remove containers liés à AI Box"
# Containers connus (extensible). On ratisse large : tout container dont
# le nom commence par aibox-* + les apps héritées.
mapfile -t AIBOX_CTNS < <(docker ps -a --format '{{.Names}}' | grep -E '^(aibox-|aibox_|ollama$|n8n$|portainer$|uptime-kuma$|open-webui$|nginx-proxy-manager$|dashy$|duplicati$)' || true)
for c in "${AIBOX_CTNS[@]}"; do
    [[ -z "$c" ]] && continue
    # On préserve le container 'ollama' (sinon le volume seul ne suffit pas
    # à éviter le re-pull des modèles : l'image elle-même peut être lente).
    if [[ "$c" == "ollama" ]]; then
        echo "  ⏸  $c (préservé — modèles)"
        continue
    fi
    echo "  ⏹  $c"
    run docker stop "$c" >/dev/null 2>&1 || true
    run docker rm   "$c" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------------------
# [3/8] Remove volumes (sauf ceux contenant 'ollama')
# ---------------------------------------------------------------------------
hr
c_blue "[3/8] Suppression des volumes Docker (sauf ceux 'ollama')"
mapfile -t VOLS < <(docker volume ls --format '{{.Name}}' | grep -iE '^(aibox|anythingllm_|stack_xefia_)' || true)
for v in "${VOLS[@]}"; do
    [[ -z "$v" ]] && continue
    if echo "$v" | grep -qi 'ollama'; then
        echo "  ⏸  $v (préservé — modèles)"
        continue
    fi
    echo "  🗑  $v"
    run docker volume rm "$v" >/dev/null 2>&1 || \
        c_yellow "    (ne peut pas être supprimé maintenant)"
done

# ---------------------------------------------------------------------------
# [4/8] Remove network aibox_net
# ---------------------------------------------------------------------------
hr
c_blue "[4/8] Suppression du réseau Docker aibox_net"
if docker network ls --format '{{.Name}}' | grep -qx aibox_net; then
    run docker network rm aibox_net >/dev/null 2>&1 || \
        c_yellow "  (network occupé — sera recréé par install)"
fi

# ---------------------------------------------------------------------------
# [5/8] Disable + remove services systemd
# ---------------------------------------------------------------------------
hr
c_blue "[5/8] Désactivation services systemd AI Box"
for svc in aibox-firstrun aibox-mdns-aliases; do
    if systemctl list-unit-files | grep -qE "^${svc}\.service"; then
        echo "  ⏹  ${svc}.service"
        run $SUDO systemctl disable --now "${svc}.service" >/dev/null 2>&1 || true
        run $SUDO rm -f "/etc/systemd/system/${svc}.service"
    fi
done
run $SUDO rm -f /etc/avahi/services/aibox.service
run $SUDO rm -f /usr/local/bin/aibox-mdns-publish.sh
run $SUDO rm -f /var/lib/aibox/.configured
run $SUDO systemctl daemon-reload

# ---------------------------------------------------------------------------
# [6/8] Wipe /srv/ai-stack/
# ---------------------------------------------------------------------------
hr
c_blue "[6/8] Suppression de $TARGET_DIR"
if [[ -d "$TARGET_DIR" ]]; then
    run $SUDO rm -rf "$TARGET_DIR"
fi

# ---------------------------------------------------------------------------
# [7/8] Re-clone du repo
# ---------------------------------------------------------------------------
hr
c_blue "[7/8] Clone $REPO_URL ($BRANCH) → $TARGET_DIR"
PARENT="$(dirname "$TARGET_DIR")"
run $SUDO mkdir -p "$PARENT"
# git clone avec un user non-root pour que la propriété soit cohérente.
# On utilise le user qui a invoqué le sudo (SUDO_USER), sinon le current.
INVOKER="${SUDO_USER:-${USER:-clikinfo}}"
run $SUDO -u "$INVOKER" git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR"

# ---------------------------------------------------------------------------
# [8/8] Run install-firstrun.sh
# ---------------------------------------------------------------------------
hr
c_blue "[8/8] Lancement de install-firstrun.sh (mDNS + Avahi + wizard)"
if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] $TARGET_DIR/services/setup/install-firstrun.sh"
else
    $SUDO bash "$TARGET_DIR/services/setup/install-firstrun.sh"
fi

# ---------------------------------------------------------------------------
hr
c_green "════════════════════════════════════════════════════════════════════"
c_green "  ✓ Wipe + reinstall complet"
c_green "════════════════════════════════════════════════════════════════════"
echo
LAN_IP="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo '?.?.?.?')"
c_blue "🌐 Accès au wizard :"
echo "    http://aibox.local            (depuis Windows/Mac/Linux/iPhone)"
echo "    http://$LAN_IP                 (fallback IP directe)"
echo
c_blue "📦 Backup pré-wipe (au cas où) :"
ls -1 "$BACKUP_DIR"/wipe-*.tar.gz 2>/dev/null | tail -1 || echo "    (aucun)"
echo
