#!/usr/bin/env bash
# =============================================================================
# AI Box — Installeur interactif
# =============================================================================
# Usage: ./install.sh
# Prérequis: Ubuntu 22.04+, Docker 24+, NVIDIA Container Toolkit (si GPU)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- Helpers ----------------------------------------------------------------
c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
hr()       { printf "%.0s─" {1..70}; printf "\n"; }

ask() {
  local prompt="$1" default="${2:-}"
  local answer
  if [[ -n "$default" ]]; then
    read -rp "$(c_blue "  $prompt") [$default] : " answer
    echo "${answer:-$default}"
  else
    read -rp "$(c_blue "  $prompt") : " answer
    echo "$answer"
  fi
}

ask_yn() {
  local prompt="$1" default="${2:-n}" answer
  read -rp "$(c_blue "  $prompt") [y/N] : " answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" || "${answer,,}" == "o" ]]
}

gen_secret() {
  local len="${1:-48}"
  tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c "$len"
}

# ---- Fonction de déploiement (réutilisable depuis CLI ou wizard web) -------
deploy_stack() {
  local env_file="${SCRIPT_DIR}/.env"
  [[ -f "$env_file" ]] || { c_red "  ✗ .env manquant à $env_file"; return 1; }
  set -a; . "$env_file"; set +a

  c_blue "  → Création du réseau Docker partagé..."
  docker network create "${NETWORK_NAME:-aibox_net}" 2>/dev/null || true

  c_blue "  → Pull des images (peut prendre 5-15 min)..."
  docker compose --env-file "$env_file" pull
  ( cd services/authentik && docker compose --env-file "$env_file" pull )
  ( cd services/dify      && docker compose --env-file "$env_file" pull )
  ( cd services/inference && docker compose --env-file "$env_file" pull )
  ( cd services/edge      && docker compose --env-file "$env_file" pull ) || true

  c_blue "  → Démarrage Qdrant (top-level)..."
  docker compose --env-file "$env_file" up -d

  c_blue "  → Démarrage Authentik..."
  ( cd services/authentik && docker compose --env-file "$env_file" up -d )

  c_blue "  → Démarrage Dify..."
  ( cd services/dify && docker compose --env-file "$env_file" up -d )

  c_blue "  → Démarrage Inference (Ollama + Open WebUI)..."
  ( cd services/inference && docker compose --env-file "$env_file" up -d ) || \
      c_yellow "    (déjà en cours d'exécution ou conflict avec stack héritée — non bloquant)"

  c_blue "  → Démarrage Edge Caddy..."
  # --force-recreate : Docker compose ne ré-attache PAS les networks d'un
  # container existant. Si edge-caddy a été créé une fois avec un seul
  # network (cas des resets en boucle), un simple up -d le laisse mal-
  # connecté. force-recreate garantit qu'il pointe sur tous les networks
  # déclarés dans le compose (aibox_net + ollama_net).
  ( cd services/edge && docker compose --env-file "$env_file" up -d --force-recreate ) || \
      c_yellow "    (Caddy non démarré — souvent un conflit de ports avec NPM, à régler après)"

  c_blue "  → Démarrage AI Box App (front unifié)..."
  ( cd services/app && docker compose --env-file "$env_file" up -d --build ) || \
      c_yellow "    (App non démarrée — sera relancée par le wizard après provisioning OIDC)"

  # Démarre la stack héritée (n8n, Portainer, Uptime Kuma, NPM, Duplicati, Dashy)
  # si elle existe sur l'hôte. Important pour que le provisioning des comptes
  # n8n/Portainer fonctionne après reset.
  if [[ -f /srv/anythingllm/docker-compose.yml ]]; then
    c_blue "  → Démarrage stack héritée (n8n, Portainer, Uptime Kuma...)"
    ( cd /srv/anythingllm && docker compose -p stack_xefia up -d 2>&1 | tail -5 ) || \
      c_yellow "    (stack héritée partiellement démarrée)"
  fi
}

# ---- Mode non-interactif (utilisé par le wizard web ou CI) -----------------
if [[ "${AIBOX_NONINTERACTIVE:-0}" == "1" ]]; then
  c_blue "════════════════════════════════════════════════════════════════════"
  c_blue "  AI Box — Déploiement non-interactif (mode wizard web)"
  c_blue "════════════════════════════════════════════════════════════════════"
  if [[ ! -f "${SCRIPT_DIR}/.env" ]]; then
    c_red "Erreur : .env attendu à ${SCRIPT_DIR}/.env (à écrire par le wizard avant)."
    exit 1
  fi
  deploy_stack
  c_green "════════════════════════════════════════════════════════════════════"
  c_green "  ✓ Déploiement non-interactif terminé"
  c_green "════════════════════════════════════════════════════════════════════"
  exit 0
fi

# ---- Header -----------------------------------------------------------------
clear
c_green "╔══════════════════════════════════════════════════════════════════╗"
c_green "║              AI BOX — Installation interactive                    ║"
c_green "╚══════════════════════════════════════════════════════════════════╝"
echo
c_yellow "Cet assistant va configurer votre serveur IA local."
c_yellow "Toutes les valeurs sont modifiables après installation dans .env"
echo
hr

# ---- Vérifs préalables -------------------------------------------------------
c_blue "[1/7] Vérification des prérequis..."
command -v docker >/dev/null || { c_red "Docker non installé. Abandon."; exit 1; }
docker compose version >/dev/null 2>&1 || { c_red "Docker Compose v2 non disponible."; exit 1; }
c_green "  ✓ Docker $(docker --version | awk '{print $3}' | tr -d ',') détecté"
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  c_green "  ✓ GPU détectée : $GPU_NAME (${GPU_VRAM} MiB)"
else
  GPU_NAME="none"
  GPU_VRAM="0"
  c_yellow "  ⚠ Pas de GPU NVIDIA — certains modèles seront lents en CPU"
fi
hr

# ---- Étape 2 : identité client ----------------------------------------------
c_blue "[2/7] Identité du client"
CLIENT_NAME=$(ask "Nom de l'entreprise cliente" "Acme SARL")
echo
echo "  Secteurs : 1) services  2) btp  3) juridique  4) sante  5) immobilier"
echo "             6) comptabilite  7) autre"
SECTOR_NUM=$(ask "Choix [1-7]" "1")
case "$SECTOR_NUM" in
  1) CLIENT_SECTOR="services" ;;
  2) CLIENT_SECTOR="btp" ;;
  3) CLIENT_SECTOR="juridique" ;;
  4) CLIENT_SECTOR="sante" ;;
  5) CLIENT_SECTOR="immobilier" ;;
  6) CLIENT_SECTOR="comptabilite" ;;
  *) CLIENT_SECTOR="autre" ;;
esac
CLIENT_USERS_COUNT=$(ask "Nombre d'utilisateurs estimés" "10")
hr

# ---- Étape 3 : domaine et admin ---------------------------------------------
c_blue "[3/7] Domaine et compte administrateur"
DOMAIN=$(ask "Domaine racine (ex: ai.monclient.fr)" "ai.${CLIENT_NAME// /-}.local")
DOMAIN="${DOMAIN,,}"
ADMIN_EMAIL=$(ask "Email administrateur" "admin@${DOMAIN#*.}")
ADMIN_USERNAME=$(ask "Identifiant admin Authentik" "akadmin")
hr

# ---- Étape 4 : profil hardware ----------------------------------------------
c_blue "[4/7] Profil matériel"
echo "  1) TPE       — RAM 32 Go, GPU 12-16 Go, 1-5 users"
echo "  2) PME       — RAM 64 Go, GPU 24 Go, 5-20 users"
echo "  3) PME+      — RAM 128 Go, GPU 48 Go+, 20-100 users"
HW_NUM=$(ask "Profil [1-3]" "1")
case "$HW_NUM" in
  2) HW_PROFILE="pme" ;;
  3) HW_PROFILE="pme-plus" ;;
  *) HW_PROFILE="tpe" ;;
esac
GPU_VRAM_GB=$(( GPU_VRAM / 1024 ))
hr

# ---- Étape 5 : technologies du client ---------------------------------------
c_blue "[5/7] Technologies utilisées par le client"
c_yellow "  → ces choix activeront les connecteurs RAG et templates n8n correspondants"
echo
declare -A TECH
TECH[M365]=$(ask_yn "Microsoft 365 / Exchange / SharePoint / OneDrive ?" && echo true || echo false)
TECH[GOOGLE]=$(ask_yn "Google Workspace (Gmail, Drive) ?" && echo true || echo false)
TECH[AD]=$(ask_yn "Active Directory / Azure AD / LDAP ?" && echo true || echo false)
TECH[ODOO]=$(ask_yn "Odoo ?" && echo true || echo false)
TECH[SAGE]=$(ask_yn "Sage (compta ou gestion) ?" && echo true || echo false)
TECH[SALESFORCE]=$(ask_yn "Salesforce ?" && echo true || echo false)
TECH[HUBSPOT]=$(ask_yn "HubSpot ?" && echo true || echo false)
TECH[PG]=$(ask_yn "Base PostgreSQL métier ?" && echo true || echo false)
TECH[MYSQL]=$(ask_yn "Base MySQL/MariaDB ?" && echo true || echo false)
TECH[MSSQL]=$(ask_yn "Base Microsoft SQL Server ?" && echo true || echo false)
TECH[GLPI]=$(ask_yn "GLPI (helpdesk) ?" && echo true || echo false)
TECH[NEXTCLOUD]=$(ask_yn "Nextcloud ?" && echo true || echo false)
TECH[SMB]=$(ask_yn "Partage SMB/CIFS local (NAS) ?" && echo true || echo false)
hr

# ---- Étape 6 : génération .env + client_config.yaml --------------------------
c_blue "[6/7] Génération de la configuration..."
ADMIN_PASSWORD=$(gen_secret 24)
PG_DIFY_PASSWORD=$(gen_secret 32)
PG_AUTHENTIK_PASSWORD=$(gen_secret 32)
AUTHENTIK_SECRET_KEY=$(gen_secret 60)
DIFY_SECRET_KEY=$(gen_secret 50)
QDRANT_API_KEY=$(gen_secret 32)

cat > .env <<EOF
# Généré par install.sh le $(date -Iseconds)
# Ne pas committer ce fichier.

# ----- IDENTITÉ CLIENT -----
CLIENT_NAME="${CLIENT_NAME}"
CLIENT_SECTOR=${CLIENT_SECTOR}
CLIENT_USERS_COUNT=${CLIENT_USERS_COUNT}

# ----- DOMAINE & TLS -----
DOMAIN=${DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL}

# ----- ADMIN PAR DÉFAUT (Authentik) -----
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# ----- HARDWARE PROFILE -----
HW_PROFILE=${HW_PROFILE}
GPU_VRAM_GB=${GPU_VRAM_GB}

# ----- MODÈLES OLLAMA -----
LLM_MAIN=qwen2.5:7b
LLM_EMBED=bge-m3
LLM_CODE=

# ----- TECHNOS DU CLIENT -----
CLIENT_HAS_M365=${TECH[M365]}
CLIENT_HAS_GOOGLE=${TECH[GOOGLE]}
CLIENT_HAS_AD=${TECH[AD]}
CLIENT_HAS_ODOO=${TECH[ODOO]}
CLIENT_HAS_SAGE=${TECH[SAGE]}
CLIENT_HAS_SALESFORCE=${TECH[SALESFORCE]}
CLIENT_HAS_HUBSPOT=${TECH[HUBSPOT]}
CLIENT_HAS_PG=${TECH[PG]}
CLIENT_HAS_MYSQL=${TECH[MYSQL]}
CLIENT_HAS_MSSQL=${TECH[MSSQL]}
CLIENT_HAS_GLPI=${TECH[GLPI]}
CLIENT_HAS_NEXTCLOUD=${TECH[NEXTCLOUD]}
CLIENT_HAS_SMB=${TECH[SMB]}

# ----- SECRETS -----
PG_DIFY_PASSWORD=${PG_DIFY_PASSWORD}
PG_AUTHENTIK_PASSWORD=${PG_AUTHENTIK_PASSWORD}
AUTHENTIK_SECRET_KEY=${AUTHENTIK_SECRET_KEY}
DIFY_SECRET_KEY=${DIFY_SECRET_KEY}
QDRANT_API_KEY=${QDRANT_API_KEY}

# ----- VERSIONS (épinglage reproductibilité) -----
QDRANT_VERSION=v1.13.4
DIFY_VERSION=1.10.1
AUTHENTIK_VERSION=2025.10.0

# ----- RÉSEAU DOCKER -----
NETWORK_NAME=aibox_net
EOF

# Génération client_config.yaml (consommable par le futur portail)
cat > client_config.yaml <<EOF
# AI Box - Configuration client
# Généré le $(date -Iseconds)
# Ce fichier est la source de vérité de tout ce qui concerne le client.

client:
  name: "${CLIENT_NAME}"
  sector: ${CLIENT_SECTOR}
  users_count: ${CLIENT_USERS_COUNT}
  domain: ${DOMAIN}
  admin_email: ${ADMIN_EMAIL}

infrastructure:
  hw_profile: ${HW_PROFILE}
  gpu_name: "${GPU_NAME}"
  gpu_vram_mb: ${GPU_VRAM}

technologies:
  microsoft_365: ${TECH[M365]}
  google_workspace: ${TECH[GOOGLE]}
  active_directory: ${TECH[AD]}
  odoo: ${TECH[ODOO]}
  sage: ${TECH[SAGE]}
  salesforce: ${TECH[SALESFORCE]}
  hubspot: ${TECH[HUBSPOT]}
  postgresql: ${TECH[PG]}
  mysql: ${TECH[MYSQL]}
  mssql: ${TECH[MSSQL]}
  glpi: ${TECH[GLPI]}
  nextcloud: ${TECH[NEXTCLOUD]}
  smb: ${TECH[SMB]}

models:
  llm_main: qwen2.5:7b
  llm_embed: bge-m3
EOF

c_green "  ✓ .env créé"
c_green "  ✓ client_config.yaml créé"
hr

# ---- Étape 7 : déploiement --------------------------------------------------
c_blue "[7/7] Déploiement de la stack"
echo
if ! ask_yn "Lancer le déploiement maintenant ?" "y"; then
  c_yellow "Annulation. Pour démarrer plus tard : docker compose up -d"
  exit 0
fi

deploy_stack

hr
c_green "╔══════════════════════════════════════════════════════════════════╗"
c_green "║                     INSTALLATION TERMINÉE                          ║"
c_green "╚══════════════════════════════════════════════════════════════════╝"
echo
c_yellow "📍 URLs (à brancher dans NPM avec le domaine ${DOMAIN}) :"
echo "    • Authentik (SSO + Dashboard) → http://localhost:9000"
echo "    • Dify (Agent builder)         → http://localhost:8081"
echo "    • Qdrant (vector DB)           → http://localhost:6333"
echo
c_yellow "🔐 Compte administrateur Authentik :"
echo "    • Identifiant : ${ADMIN_USERNAME}"
echo "    • Mot de passe : ${ADMIN_PASSWORD}"
echo "    • Email :       ${ADMIN_EMAIL}"
echo
c_yellow "📋 Étapes suivantes :"
echo "    1. Connecter Authentik à votre domaine (NPM proxy + TLS)"
echo "    2. Configurer Dify : créer un workspace, brancher Ollama, créer un agent"
echo "    3. Importer les workflows n8n correspondant aux technos cochées"
echo
c_blue "💾 Configuration sauvegardée dans : client_config.yaml"
c_blue "🚀 Pour mettre à jour : ./update.sh"
echo
