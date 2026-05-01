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

# Génère un password "strong" garantissant au moins 1 majuscule, 1 minuscule,
# 1 chiffre et 1 caractère spécial. Requis par certains services (n8n, GLPI…)
# qui rejettent les mots de passe faibles. Préfixe "Aa1!" puis remplit avec
# de l'aléatoire — l'ordre est mélangé pour éviter le pattern statique.
gen_strong_pass() {
  local len="${1:-24}"
  if [[ $len -lt 8 ]]; then len=8; fi
  local fixed="Aa1!"  # garantit les 4 classes
  local rest_len=$((len - 4))
  local rest
  rest=$(tr -dc 'A-Za-z0-9!#$%*+-=?@_' </dev/urandom | head -c "$rest_len")
  echo -n "${fixed}${rest}" | fold -w1 | shuf | tr -d '\n'
}

# ---- Fonction de déploiement (réutilisable depuis CLI ou wizard web) -------
prepare_app_data_dirs() {
  # Permissions des dossiers persistants montés en bind dans les containers.
  #
  # Problème : par défaut, `mkdir /srv/ai-stack/data` (lancé en root via sudo
  # ou par dpkg) crée un dossier owned root:root, mais le container
  # aibox-app tourne en uid 1001 (user "nextjs", Dockerfile services/app).
  # Sans chown, tout `fs.writeFile("/data/...")` rate avec EACCES dès qu'on
  # essaie d'enregistrer un agent custom, audit log, état connecteurs, etc.
  #
  # Idempotent : à relancer à chaque deploy_stack ne pose pas de problème
  # (chown -R sur ~10 KB de JSON, négligeable).
  c_blue "  → Préparation des dossiers persistants /data..."
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p /srv/ai-stack/data
    sudo chown -R 1001:1001 /srv/ai-stack/data
    sudo chmod 755 /srv/ai-stack/data
  else
    # Mode root direct (wizard web tourne déjà en root)
    mkdir -p /srv/ai-stack/data
    chown -R 1001:1001 /srv/ai-stack/data 2>/dev/null || true
    chmod 755 /srv/ai-stack/data 2>/dev/null || true
  fi
}

deploy_stack() {
  local env_file="${SCRIPT_DIR}/.env"
  [[ -f "$env_file" ]] || { c_red "  ✗ .env manquant à $env_file"; return 1; }
  set -a; . "$env_file"; set +a

  prepare_app_data_dirs

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

  # NOTE — Edge Caddy n'est PAS démarré ici. Quand install.sh tourne en
  # mode wizard (depuis aibox-setup-api), aibox-setup-caddy tient encore
  # le port 80 → edge-caddy ne peut pas binder et reste créé sans
  # networking propre, qui contamine ensuite le handoff. C'est le
  # _HANDOFF_SCRIPT côté setup-api/main.py:configure_finish qui démarre
  # edge-caddy AVEC --force-recreate après avoir libéré le port 80.
  # En mode CLI interactif (sans wizard), edge-caddy peut être démarré
  # manuellement à la fin :  cd services/edge && docker compose up -d
  c_blue "  → Edge Caddy : démarrage différé au handoff post-wizard"

  c_blue "  → Démarrage AI Box App (front unifié)..."
  ( cd services/app && docker compose --env-file "$env_file" up -d --build ) || \
      c_yellow "    (App non démarrée — sera relancée par le wizard après provisioning OIDC)"

  c_blue "  → Démarrage n8n (workflow automation)..."
  ( cd services/n8n && docker compose --env-file "$env_file" up -d ) || \
      c_yellow "    (n8n non démarré — workflows non disponibles)"

  c_blue "  → Démarrage Monitoring (Prometheus + Grafana + Loki + DCGM)..."
  # DCGM nécessite GPU NVIDIA — démarre quand même sans pour Prometheus seul.
  ( cd services/monitoring && docker compose --env-file "$env_file" up -d ) || \
      c_yellow "    (Monitoring partiellement démarré — métriques /system page peuvent être vides)"

  # ---- Agents autonomes (LangGraph sidecar : triage email, devis, facture) -
  c_blue "  → Démarrage Agents autonomes (LangGraph)..."
  if [[ -d services/agents-autonomous ]]; then
    ( cd services/agents-autonomous && docker compose --env-file "$env_file" up -d --build ) || \
        c_yellow "    (Agents non démarrés — vérifier AGENTS_API_KEY dans .env)"
  fi

  # ---- Mémoire long-terme (mem0-style sur Qdrant) --------------------------
  c_blue "  → Démarrage Memory (mem0)..."
  if [[ -d services/memory ]]; then
    ( cd services/memory && docker compose --env-file "$env_file" up -d --build ) || \
        c_yellow "    (Memory non démarré — vérifier MEM0_API_KEY dans .env)"
  fi

  # ---- vLLM (optionnel, tier pme/+ uniquement) ------------------------------
  if [[ "${HW_PROFILE:-tpe}" =~ ^pme ]] && [[ -d services/inference-vllm ]]; then
    c_blue "  → Démarrage vLLM (tier ${HW_PROFILE})..."
    ( cd services/inference-vllm && docker compose --env-file "$env_file" up -d ) || \
        c_yellow "    (vLLM non démarré — vérifier GPU 16+ Go VRAM disponibles)"
  fi

  # ---- Services post-sprint 2026-05 (best-effort) ---------------------------
  # Langfuse (observability LLM), TTS Piper (voix neural FR), SearXNG (web
  # search). Démarrés best-effort : si l'image n'est pas encore pull et
  # l'admin n'a pas la bande passante, on continue sans bloquer.
  if [[ -d services/observability ]]; then
    c_blue "  → Démarrage Langfuse (observability)..."
    ( cd services/observability && docker compose --env-file "$env_file" up -d ) || \
        c_yellow "    (Langfuse non démarré — relancer manuellement plus tard)"
  fi
  if [[ -d services/tts ]]; then
    c_blue "  → Démarrage TTS Piper (synthèse vocale FR)..."
    ( cd services/tts && docker compose --env-file "$env_file" up -d ) || \
        c_yellow "    (TTS non démarré — useTTS fallback Web Speech API)"
  fi
  if [[ -d services/search ]]; then
    c_blue "  → Démarrage SearXNG (web search métamoteur)..."
    ( cd services/search && docker compose --env-file "$env_file" up -d ) || \
        c_yellow "    (SearXNG non démarré — tool web_search inactif)"
  fi

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
# ---- Sidecars & connecteurs : auto-génération obligatoire ----
# Principe produit : aucun secret ne doit être saisi à la main par l'admin
# client (cf. memory/product_appliance_principle.md). Ces valeurs sont
# utilisées uniquement entre nos services internes ; les credentials vers
# des SaaS externes (Pennylane, MS Graph...) sont saisis via UI /connectors.
AGENTS_API_KEY=$(gen_secret 48)
MEM0_API_KEY=$(gen_secret 48)
FEC_TOOL_API_KEY=$(gen_secret 48)
PENNYLANE_TOOL_API_KEY=$(gen_secret 48)
GLPI_TOOL_API_KEY=$(gen_secret 48)
ODOO_TOOL_API_KEY=$(gen_secret 48)
TEXT2SQL_TOOL_API_KEY=$(gen_secret 48)
# n8n exige un password fort (8+ chars, 1 maj, 1 chiffre). On génère un
# password dédié plutôt que réutiliser ADMIN_PASSWORD qui peut ne pas
# respecter ces règles. Le wizard provisionne n8n owner avec celui-ci.
N8N_PASSWORD=$(gen_strong_pass 24)

# Services optionnels post-sprint 2026-05 (Langfuse, TTS Piper, SearXNG).
# Vars auto-générées : si l'admin ne déploie pas le compose correspondant,
# elles restent dormantes (no-op côté aibox-app). Pour activer :
#   - Langfuse :   cd services/observability && docker compose up -d
#   - TTS Piper :  cd services/tts && docker compose up -d
#   - SearXNG :    cd services/search && docker compose up -d
LANGFUSE_DB_PASSWORD=$(gen_secret 32)
LANGFUSE_SALT=$(gen_secret 32)
LANGFUSE_NEXTAUTH_SECRET=$(gen_secret 64)
LANGFUSE_PUBLIC_KEY="pk-lf-aibox-$(gen_secret 24)"
LANGFUSE_SECRET_KEY="sk-lf-aibox-$(gen_secret 32)"
SEARXNG_SECRET=$(gen_secret 64)

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
# Modèle principal — qwen3:14b (~9 GB VRAM, drop-in remplaçant qwen2.5:14b).
# Avantages mesurés vs qwen2.5:14b (audit BentoML 2026-05-01) :
#   - Multilingue FR natif (119 langues vs ~10 chez qwen2.5)
#   - Function calling natif (résout la lenteur Concierge sur ReAct)
#   - Mode thinking/non-thinking switchable au runtime
#   - Qwen3-14B base ≈ Qwen2.5-32B base sur MMLU
# Compromis : 12 GB VRAM (RTX 4070 Super OK). Si GPU plus petit (8 GB),
# changer en qwen3:8b dans .env post-install (gain latence + Phi-4 battu).
LLM_MAIN=qwen3:14b
LLM_EMBED=bge-m3
# Modèle vision — utilisé pour les agents avec vision:true (analyse
# d'images, captures d'écran, photos). qwen2.5vl:7b est multimodal natif
# (qwen3vl pas encore stable sur Ollama au 2026-05-01 — switch quand dispo).
LLM_VISION=qwen2.5vl:7b
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

# ----- SIDECARS & CONNECTEURS (auto-générés, ne PAS modifier) -----
AGENTS_API_KEY=${AGENTS_API_KEY}
MEM0_API_KEY=${MEM0_API_KEY}
FEC_TOOL_API_KEY=${FEC_TOOL_API_KEY}
PENNYLANE_TOOL_API_KEY=${PENNYLANE_TOOL_API_KEY}
GLPI_TOOL_API_KEY=${GLPI_TOOL_API_KEY}
ODOO_TOOL_API_KEY=${ODOO_TOOL_API_KEY}
TEXT2SQL_TOOL_API_KEY=${TEXT2SQL_TOOL_API_KEY}
N8N_PASSWORD=${N8N_PASSWORD}

# ----- HOST URLS sidecars (network_mode: host) -----
INFERENCE_BACKEND=ollama
CHECKPOINTER_MODE=postgres
MEM0_BASE_URL=http://127.0.0.1:8087
AGENTS_BASE_URL=http://127.0.0.1:8085
PENNYLANE_TOOL_URL=http://127.0.0.1:8090
FEC_TOOL_URL=http://127.0.0.1:8091

# ----- VERSIONS (épinglage reproductibilité) -----
QDRANT_VERSION=v1.13.4
DIFY_VERSION=1.10.1
AUTHENTIK_VERSION=2025.10.0

# ----- RÉSEAU DOCKER -----
NETWORK_NAME=aibox_net

# ----- LANGFUSE (observability, optionnel) -----
LANGFUSE_DB_PASSWORD=${LANGFUSE_DB_PASSWORD}
LANGFUSE_SALT=${LANGFUSE_SALT}
LANGFUSE_NEXTAUTH_SECRET=${LANGFUSE_NEXTAUTH_SECRET}
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
LANGFUSE_BASE_URL=http://127.0.0.1:3001
LANGFUSE_PUBLIC_URL=http://localhost:3001

# ----- TTS Piper (voix neural FR, optionnel) -----
TTS_BACKEND_URL=http://127.0.0.1:5500
TTS_DEFAULT_VOICE=larynx:siwis-glow_tts

# ----- SearXNG (web search, optionnel) -----
SEARXNG_SECRET=${SEARXNG_SECRET}
SEARXNG_URL=http://127.0.0.1:8888
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
