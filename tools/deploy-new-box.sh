#!/usr/bin/env bash
# =============================================================================
# tools/deploy-new-box.sh
# -----------------------------------------------------------------------------
# Déploie une AI Box COMPLÈTE sur une machine Ubuntu vierge en UNE commande,
# sans aucune question. C'est le workflow "v2" qui remplace la séquence
# manuelle :
#
#   ssh root@box "apt install ..."
#   rsync -av . root@box:/srv/ai-stack/
#   ./tools/provision-master-creds.sh root@box
#   ssh root@box "cd /srv/ai-stack && ./install.sh"   ← ~10 questions
#
# par UNE commande zero-question :
#
#   ./tools/deploy-new-box.sh root@new-box.tld
#
# Le wizard web (port 80) prend ensuite le relais pour collecter les vraies
# valeurs auprès du client (nom entreprise, secteur, sous-domaine CF, etc.).
# Tu, BoxIA, n'as pas à connaître ces valeurs.
#
# Étapes exécutées :
#   1. Test SSH + détection OS
#   2. Install Docker + NVIDIA Container Toolkit (idempotent)
#   3. Push du repo (rsync) vers /srv/ai-stack/
#   4. Push des master credentials Cloudflare via provision-master-creds.sh
#   5. Lancement install.sh en mode AIBOX_BOOTSTRAP=1 (zero-question)
#   6. Affichage de l'URL du wizard
#
# Usage :
#   ./tools/deploy-new-box.sh <ssh-target> [--skip-docker] [--skip-creds] [--branch <name>]
#
# Variables :
#   CREDS_FILE    Chemin du fichier creds local (default: ~/.boxia/master-creds.env)
#   REMOTE_PATH   Chemin sur la box (default: /srv/ai-stack)
# =============================================================================
set -euo pipefail

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*" >&2; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*" >&2; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*" >&2; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }
hr()       { printf "%.0s─" {1..70} >&2; printf "\n" >&2; }

# ---- Args ------------------------------------------------------------------
SSH_TARGET=""
SKIP_DOCKER=0
SKIP_CREDS=0
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --skip-creds)  SKIP_CREDS=1;  shift ;;
    --branch)      BRANCH="$2";   shift 2 ;;
    -h|--help)
      sed -n '4,40p' "$0"
      exit 0
      ;;
    -*)
      c_red "Argument inconnu : $1"
      exit 1
      ;;
    *)
      if [[ -z "$SSH_TARGET" ]]; then
        SSH_TARGET="$1"
      else
        c_red "Argument inattendu : $1"
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$SSH_TARGET" ]]; then
  c_red "Usage : $0 <ssh-target> [--skip-docker] [--skip-creds] [--branch <name>]"
  c_red "Exemple : $0 root@new-box.tld"
  exit 1
fi

# ---- Variables -------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CREDS_FILE="${CREDS_FILE:-$HOME/.boxia/master-creds.env}"
REMOTE_PATH="${REMOTE_PATH:-/srv/ai-stack}"

c_blue "════════════════════════════════════════════════════════════════════"
c_blue "  AI BOX — Bootstrap d'une nouvelle box"
c_blue "════════════════════════════════════════════════════════════════════"
c_blue "  → Cible SSH       : $SSH_TARGET"
c_blue "  → Repo local      : $REPO_ROOT"
c_blue "  → Branche         : ${BRANCH:-<HEAD courant>}"
c_blue "  → Master creds    : $CREDS_FILE"
c_blue "  → Path distant    : $REMOTE_PATH"
[[ $SKIP_DOCKER -eq 1 ]] && c_yellow "  → Skip install Docker"
[[ $SKIP_CREDS -eq 1 ]]  && c_yellow "  → Skip provisioning master creds"
hr

# ---- Étape 1 : test SSH + détection OS -------------------------------------
c_blue "[1/5] Test connexion SSH + détection OS..."
if ! OS_INFO=$(ssh -o ConnectTimeout=10 "$SSH_TARGET" 'cat /etc/os-release 2>/dev/null | head -3' 2>&1); then
  c_red "✗ SSH échoué vers $SSH_TARGET"
  c_red "  $OS_INFO"
  exit 1
fi
echo "$OS_INFO" | sed 's/^/    /' >&2
if ! echo "$OS_INFO" | grep -qi "ubuntu"; then
  c_yellow "  ⚠ La cible n'est pas Ubuntu. Le script peut échouer (Docker install pour Debian-like)."
fi
c_green "  ✓ SSH OK"
hr

# ---- Étape 2 : install Docker + NVIDIA toolkit -----------------------------
if [[ $SKIP_DOCKER -eq 1 ]]; then
  c_yellow "[2/5] Skip install Docker (--skip-docker)"
else
  c_blue "[2/5] Vérification/install Docker..."
  # On envoie un script idempotent en stdin SSH
  ssh "$SSH_TARGET" 'bash -s' <<'REMOTE_DOCKER'
set -euo pipefail

# Détecte sudo / root
if [[ "$(id -u)" -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "  ✓ Docker $(docker --version | awk '{print $3}' | tr -d ',') déjà installé"
else
  echo "  → Install Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh
fi

# NVIDIA Container Toolkit (si GPU détectée)
if command -v nvidia-smi >/dev/null 2>&1; then
  if ! command -v nvidia-ctk >/dev/null 2>&1; then
    echo "  → Install NVIDIA Container Toolkit..."
    distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null || true
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
      $SUDO sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
      $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit
    $SUDO nvidia-ctk runtime configure --runtime=docker
    $SUDO systemctl restart docker
  else
    echo "  ✓ NVIDIA Container Toolkit déjà installé"
  fi
  echo "  ✓ GPU détectée : $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
else
  echo "  ⚠ Pas de GPU NVIDIA — modèles seront lents en CPU"
fi
REMOTE_DOCKER
  c_green "  ✓ Docker prêt"
fi
hr

# ---- Étape 3 : sync du code via git côté serveur ---------------------------
# Pourquoi pas rsync : pas dispo par défaut dans Git Bash Windows. git est
# universel (déjà requis pour cloner ce repo), et on bénéficie en bonus du
# tracking de version (HEAD identifié, history, rollback git reset --hard).
#
# Logique :
#   - Si /srv/ai-stack/.git existe → git fetch + reset --hard sur le ref voulu
#   - Sinon → git clone (cas box neuve sans repo)
#
# Le `--branch` permet de déployer une branche différente de main (utile pour
# tester un PR avant merge). Default = main.
c_blue "[3/5] Sync du code via git côté serveur..."
GIT_REF="${BRANCH:-main}"
GIT_REPO_URL="${GIT_REPO_URL:-https://github.com/Tobaz34/BoxIA.git}"

c_blue "  → Repo  : $GIT_REPO_URL"
c_blue "  → Ref   : $GIT_REF"

ssh "$SSH_TARGET" "
  set -e
  # Création du dossier (sans sudo si possible — cf. fix précédent)
  if [ -w '$REMOTE_PATH' ] || ([ ! -e '$REMOTE_PATH' ] && [ -w \"\$(dirname '$REMOTE_PATH')\" ]); then
    mkdir -p '$REMOTE_PATH'
  elif [ \"\$(id -u)\" -eq 0 ]; then
    mkdir -p '$REMOTE_PATH'
  else
    sudo mkdir -p '$REMOTE_PATH'
    sudo chown -R \$(id -u):\$(id -g) '$REMOTE_PATH'
  fi

  cd '$REMOTE_PATH'
  if [ -d .git ]; then
    echo '  → git fetch + reset --hard origin/$GIT_REF'
    git fetch origin '$GIT_REF'
    git reset --hard 'origin/$GIT_REF'
  else
    echo '  → git clone $GIT_REPO_URL (initial)'
    # Pour cloner dans un dossier non-vide on doit être créatif :
    # clone dans /tmp puis bouger les fichiers .git
    if [ \"\$(ls -A 2>/dev/null | wc -l)\" -gt 0 ]; then
      # Le dossier n'est pas vide — on ne peut pas clone direct
      # On clone dans tmp et on copie .git
      TMPCLONE=\$(mktemp -d)
      git clone --branch '$GIT_REF' --single-branch '$GIT_REPO_URL' \"\$TMPCLONE/repo\"
      mv \"\$TMPCLONE/repo/.git\" .
      git reset --hard 'origin/$GIT_REF'
      rm -rf \"\$TMPCLONE\"
    else
      git clone --branch '$GIT_REF' --single-branch '$GIT_REPO_URL' .
    fi
  fi

  echo '  → HEAD :' \$(git rev-parse --short HEAD) '(' \$(git log -1 --pretty=%s | head -c 80) ')'
"
c_green "  ✓ Code synchronisé sur $GIT_REF"
hr

# ---- Étape 4 : push master credentials -------------------------------------
if [[ $SKIP_CREDS -eq 1 ]]; then
  c_yellow "[4/5] Skip provisioning master creds (--skip-creds)"
else
  c_blue "[4/5] Push des master credentials Cloudflare..."
  if [[ ! -f "$CREDS_FILE" ]]; then
    c_red "  ✗ $CREDS_FILE introuvable"
    c_red "    Crée-le avec : cat > $CREDS_FILE <<EOF"
    c_red "      CF_MASTER_ACCOUNT_ID=..."
    c_red "      CF_MASTER_TUNNEL_ID=..."
    c_red "      CF_MASTER_API_TOKEN=..."
    c_red "      CF_MASTER_ZONE_ID=..."
    c_red "      CF_MASTER_ROOT_DOMAIN=ialocal.pro"
    c_red "    EOF && chmod 600 $CREDS_FILE"
    c_red "    Ou relance avec --skip-creds (le wizard demandera au client)."
    exit 1
  fi
  CREDS_FILE="$CREDS_FILE" "$SCRIPT_DIR/provision-master-creds.sh" "$SSH_TARGET"
fi
hr

# ---- Étape 5 : lance install.sh en mode BOOTSTRAP --------------------------
c_blue "[5/5] Lancement install.sh en mode AIBOX_BOOTSTRAP=1..."
c_yellow "  ⏱ Durée estimée : 10-15 min (pull des images Docker, ~25 GB)"
c_yellow "     Tu peux laisser tourner — toutes les questions sont auto-répondues."
hr

# Pas de `-t` : install.sh en mode AIBOX_BOOTSTRAP=1 n'est PAS interactif
# (toutes les questions sont auto-répondues, voir install.sh ask/ask_yn).
# L'absence de TTY permet de lancer ce script depuis n'importe quel contexte
# non-interactif (CI, agent, etc.) sans erreur "TTY required".
# stdout/stderr sont transmis en streaming via SSH → on voit les logs en live.
# SETUP_PORT propagé pour les cas où :80 est déjà pris sur la box hôte
# (ex: xefia a un Nextcloud Apache externe sur :80 → SETUP_PORT=8080 fait
# servir le wizard sur :8080 sans conflit).
ssh "$SSH_TARGET" "cd $REMOTE_PATH && AIBOX_BOOTSTRAP=1 SETUP_PORT=${SETUP_PORT:-80} bash install.sh" || {
  c_red "✗ install.sh a échoué (exit $?)"
  c_red "  Inspecte les logs sur la box : ssh $SSH_TARGET 'tail -100 $REMOTE_PATH/deploy.log'"
  exit 1
}

# ---- Récap final -----------------------------------------------------------
hr
c_green "╔══════════════════════════════════════════════════════════════════╗"
c_green "║              ✓ BOX BOOTSTRAPPED — wizard prêt                     ║"
c_green "╚══════════════════════════════════════════════════════════════════╝"
echo
# Récupère l'IP LAN de la box pour donner l'URL du wizard
BOX_IP=$(ssh "$SSH_TARGET" "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<ip-de-la-box>")
WIZARD_PORT="${SETUP_PORT:-80}"
WIZARD_URL="http://$BOX_IP"
[[ "$WIZARD_PORT" != "80" ]] && WIZARD_URL="http://$BOX_IP:$WIZARD_PORT"
c_green "  → Donne ce lien au client : $WIZARD_URL"
c_green "    Le wizard collecte le nom de l'entreprise, le sous-domaine CF,"
c_green "    le branding optionnel, puis déploie tout en ~10 min."
echo
c_blue "  Logs install : ssh $SSH_TARGET 'tail -f $REMOTE_PATH/deploy.log'"
c_blue "  Logs wizard  : ssh $SSH_TARGET 'docker logs -f aibox-setup-api'"
