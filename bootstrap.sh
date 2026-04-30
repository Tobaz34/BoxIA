#!/usr/bin/env bash
# =============================================================================
# AI Box — Bootstrap installer (one-liner pour serveur Linux propre)
# =============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Tobaz34/BoxIA/main/bootstrap.sh \
#     | sudo bash
#
# Avec options (branche custom, repo fork, etc.):
#   curl -fsSL ... | sudo bash -s -- --branch dev
#
# Ce que ce script fait, idempotent :
#   1. Outils de base (git, curl, ca-certificates, lsb-release, pciutils)
#   2. Docker Engine (skip si déjà là) + ajout du SUDO_USER au groupe docker
#   3. NVIDIA Container Toolkit (auto si GPU NVIDIA détectée, skip sinon)
#   4. Clone du repo BoxIA dans /srv/ai-stack
#   5. install-firstrun.sh : mDNS aliases + service systemd + wizard sur :80
#   6. Affiche les URLs d'accès au wizard
#
# Cible: Ubuntu 22.04 LTS / 24.04 LTS. Autres distros : à tester.
# =============================================================================
set -euo pipefail

REPO_URL="${AIBOX_REPO_URL:-https://github.com/Tobaz34/BoxIA.git}"
BRANCH="${AIBOX_BRANCH:-main}"
TARGET_DIR="/srv/ai-stack"

# ---- Args -------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch=*)   BRANCH="${1#--branch=}"; shift ;;
        --branch)     BRANCH="${2:-main}"; shift 2 ;;
        --repo=*)     REPO_URL="${1#--repo=}"; shift ;;
        --repo)       REPO_URL="${2:-}"; shift 2 ;;
        --help|-h)
            sed -n '2,18p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) shift ;;
    esac
done

# ---- Helpers ----------------------------------------------------------------
c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
hr()       { printf "%.0s─" {1..70}; printf "\n"; }

# ---- Sanity checks ----------------------------------------------------------
if [[ "$EUID" -ne 0 ]]; then
    c_red "Doit être lancé en root. Utilise:"
    echo "  curl -fsSL https://raw.githubusercontent.com/Tobaz34/BoxIA/main/bootstrap.sh | sudo bash"
    exit 1
fi

if [[ ! -f /etc/os-release ]]; then
    c_red "OS non identifié (pas de /etc/os-release). Abandon."
    exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "$ID" != "ubuntu" ]]; then
    c_yellow "⚠ OS détecté: $PRETTY_NAME — testé sur Ubuntu 22.04/24.04 uniquement."
fi

c_blue "════════════════════════════════════════════════════════════════════"
c_blue "  AI Box — Installation sur $PRETTY_NAME"
c_blue "════════════════════════════════════════════════════════════════════"
echo
c_blue "→ Repo: $REPO_URL"
c_blue "→ Branche: $BRANCH"
c_blue "→ Cible: $TARGET_DIR"
echo

# ---- GPU detection ----------------------------------------------------------
apt-get update -qq
apt-get install -y -qq pciutils >/dev/null 2>&1 || true

HAS_GPU=0
GPU_NAME=""
if command -v lspci >/dev/null 2>&1 && lspci | grep -qi 'nvidia'; then
    HAS_GPU=1
    GPU_NAME=$(lspci | grep -i 'vga.*nvidia\|3d.*nvidia' | head -1 | sed 's/.*: //' || true)
    [[ -z "$GPU_NAME" ]] && GPU_NAME=$(lspci | grep -i nvidia | head -1 | sed 's/.*: //')
elif [[ -e /dev/nvidia0 ]]; then
    HAS_GPU=1
    GPU_NAME="(détectée via /dev/nvidia0)"
fi

if [[ "$HAS_GPU" -eq 1 ]]; then
    c_blue "→ GPU NVIDIA: $GPU_NAME"
else
    c_yellow "→ Pas de GPU NVIDIA — installation CPU-only (modèles plus lents)"
fi
echo

# ---- [1/5] Outils de base ---------------------------------------------------
hr
c_blue "[1/5] Outils de base"
apt-get install -y -qq \
    git curl ca-certificates lsb-release gnupg
c_green "  ✓ git, curl, ca-certificates, gnupg"

# ---- [2/5] Docker Engine ----------------------------------------------------
hr
c_blue "[2/5] Docker Engine"
if command -v docker >/dev/null 2>&1; then
    DOCKER_VER=$(docker --version | awk '{print $3}' | tr -d ',' || echo '?')
    c_green "  ✓ déjà installé (Docker $DOCKER_VER)"
else
    c_blue "  → installation via get.docker.com (peut prendre 1-2 min)"
    curl -fsSL https://get.docker.com | sh >/dev/null
    c_green "  ✓ Docker installé"
fi

# Ajoute l'invoker (SUDO_USER) au groupe docker pour qu'il puisse lancer
# docker sans sudo (utile pour les scripts de maintenance et le wizard).
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    if ! id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker; then
        usermod -aG docker "$SUDO_USER"
        c_blue "  → $SUDO_USER ajouté au groupe docker (re-login requis pour effet)"
    fi
fi

# Active + démarre le daemon (sur Ubuntu c'est déjà fait, idempotent)
systemctl enable --now docker >/dev/null 2>&1 || true

# ---- [3/5] NVIDIA Container Toolkit -----------------------------------------
hr
c_blue "[3/5] NVIDIA Container Toolkit"
if [[ "$HAS_GPU" -eq 0 ]]; then
    c_yellow "  ⊘ pas de GPU — skip"
elif docker info 2>/dev/null | grep -qE 'Runtimes:.*nvidia'; then
    c_green "  ✓ déjà configuré"
else
    c_blue "  → installation"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq
    apt-get install -y -qq nvidia-container-toolkit
    nvidia-ctk runtime configure --runtime=docker
    systemctl restart docker
    c_green "  ✓ installé + Docker reconfiguré"
fi

# ---- [4/5] Clone du repo ----------------------------------------------------
hr
c_blue "[4/5] Clone $REPO_URL ($BRANCH) → $TARGET_DIR"
INVOKER="${SUDO_USER:-root}"
INVOKER_GROUP="$(id -gn "$INVOKER" 2>/dev/null || echo "$INVOKER")"

if [[ -d "$TARGET_DIR/.git" ]]; then
    c_yellow "  $TARGET_DIR existe déjà — fetch + checkout $BRANCH"
    git -C "$TARGET_DIR" fetch origin "$BRANCH" --quiet
    git -C "$TARGET_DIR" checkout "$BRANCH" --quiet
    git -C "$TARGET_DIR" pull --ff-only --quiet
elif [[ -d "$TARGET_DIR" ]]; then
    c_red "  $TARGET_DIR existe mais n'est PAS un repo git — abandon."
    c_red "  Sauvegarde-le ou supprime-le, puis relance ce script."
    exit 1
else
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR" --quiet
    chown -R "$INVOKER":"$INVOKER_GROUP" "$TARGET_DIR"
fi
c_green "  ✓ repo prêt"

# ---- [5/5] install-firstrun.sh (mDNS + wizard) ------------------------------
hr
c_blue "[5/5] Installation portail first-run (mDNS aliases + wizard sur :80)"
bash "$TARGET_DIR/services/setup/install-firstrun.sh"

# ---- Final ------------------------------------------------------------------
hr
LAN_IP="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo '?.?.?.?')"
echo
c_green "════════════════════════════════════════════════════════════════════"
c_green "  ✓ AI Box installée — le wizard t'attend"
c_green "════════════════════════════════════════════════════════════════════"
echo
c_blue "🌐 Ouvre le wizard depuis n'importe quel poste sur le LAN :"
echo "      http://aibox.local         (Bonjour/mDNS — Windows/Mac/iPhone)"
echo "      http://$LAN_IP             (fallback IP directe)"
echo
c_blue "⏱  Le wizard dure ~5 min de saisie + 10-30 min de pull (modèles inclus)."
c_blue "📖 Doc + dépannage : $TARGET_DIR/INSTALL.md"
echo

if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    if ! id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker; then
        c_yellow "💡 Note: $SUDO_USER vient d'être ajouté au groupe docker."
        c_yellow "   Reconnecte-toi (logout/login ou: newgrp docker) pour pouvoir"
        c_yellow "   lancer 'docker' sans sudo."
        echo
    fi
fi
