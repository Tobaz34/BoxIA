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

# En mode AIBOX_BOOTSTRAP=1 (utilisé par tools/deploy-new-box.sh), `ask` et
# `ask_yn` court-circuitent le prompt et renvoient directement le default.
# Le but : préparer une box neuve sans interaction humaine — toutes les vraies
# valeurs (nom client, secteur, technos, sous-domaine CF, branding) seront
# collectées par le wizard web ensuite et écraseront ces defaults.
ask() {
  local prompt="$1" default="${2:-}"
  local answer
  if [[ "${AIBOX_BOOTSTRAP:-0}" == "1" ]]; then
    # Trace côté stderr pour qu'on voit ce qui est choisi (et que ça ne pollue
    # pas le stdout que le caller capture avec $(...)).
    printf "  %s → %s (bootstrap)\n" "$prompt" "${default:-<vide>}" >&2
    echo "$default"
    return 0
  fi
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
  if [[ "${AIBOX_BOOTSTRAP:-0}" == "1" ]]; then
    printf "  %s → %s (bootstrap)\n" "$prompt" "$default" >&2
    [[ "${default,,}" == "y" || "${default,,}" == "yes" || "${default,,}" == "o" ]]
    return $?
  fi
  read -rp "$(c_blue "  $prompt") [y/N] : " answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" || "${answer,,}" == "o" ]]
}

gen_secret() {
  # Le subshell ( set +o pipefail; ... ) est nécessaire car install.sh tourne
  # avec `set -euo pipefail` (cf. ligne 9). Le pipe `tr | head -c N` provoque
  # un SIGPIPE sur tr quand head ferme stdin après avoir lu N bytes — sans
  # pipefail c'est ignoré, mais avec pipefail ça remonte comme exit 141 et
  # casse l'install. Le subshell isole le `set +o pipefail` à cette commande.
  local len="${1:-48}"
  ( set +o pipefail; tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c "$len" )
}

# Génère un password "strong" garantissant au moins 1 majuscule, 1 minuscule,
# 1 chiffre et 1 caractère spécial. Requis par certains services (n8n, GLPI…)
# qui rejettent les mots de passe faibles. Préfixe "Aa1!" puis remplit avec
# de l'aléatoire — l'ordre est mélangé pour éviter le pattern statique.
gen_strong_pass() {
  local len="${1:-24}"
  if [[ $len -lt 8 ]]; then len=8; fi
  # Préfixe garantit les 4 classes : majuscule, minuscule, chiffre, spécial.
  # On évite le '!' (history expansion bash interactif). On utilise '#' qui
  # est safe dans tous les contextes shell + accepté par toutes les policies.
  local fixed="Aa1#"
  local rest_len=$((len - 4))
  local rest
  # CRITIQUE — Pool tr : éviter les plages accidentelles. Dans 'A-Za-z0-9...',
  # le `-` est interprété comme plage entre 2 chars. La version précédente
  # avait '+-=' qui était une plage de + (43) à = (61), incluant `<`, `;`,
  # `:`, `/`, `,` etc. — TOUS dangereux dans un .env (cassent le source).
  # Fix : ne mettre que des chars individuels. `-` doit être en première
  # ou DERNIÈRE position de la string pour être literal.
  rest=$( set +o pipefail; tr -dc 'A-Za-z0-9_.@#%' </dev/urandom | head -c "$rest_len" )
  ( set +o pipefail; echo -n "${fixed}${rest}" | fold -w1 | shuf | tr -d '\n' )
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
  # Logique idempotente :
  #   1. Si /srv/ai-stack/data existe déjà avec uid=1001 → rien à faire (skip)
  #   2. Si root (UID 0) → mkdir + chown direct, pas de sudo
  #   3. Si non-root + sudo dispo → sudo (peut prompter mdp en TTY)
  #   4. Sinon → best-effort (peut fail silencieusement si pas owner)
  #
  # Ce séquencement évite l'appel sudo systématique qui plantait dans les
  # contextes non-TTY (deploy-new-box.sh) où /data était déjà OK depuis
  # un deploy précédent (préservé par wipe-box.sh par défaut).
  c_blue "  → Préparation des dossiers persistants /data..."

  if [ -d /srv/ai-stack/data ] && [ "$(stat -c '%u' /srv/ai-stack/data 2>/dev/null)" = "1001" ]; then
    c_green "    ✓ /srv/ai-stack/data existe déjà (uid=1001) — skip"
    return 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    mkdir -p /srv/ai-stack/data
    chown -R 1001:1001 /srv/ai-stack/data
    chmod 755 /srv/ai-stack/data
    c_green "    ✓ /srv/ai-stack/data préparé (root direct)"
  elif command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p /srv/ai-stack/data
    sudo chown -R 1001:1001 /srv/ai-stack/data
    sudo chmod 755 /srv/ai-stack/data
    c_green "    ✓ /srv/ai-stack/data préparé (via sudo)"
  else
    mkdir -p /srv/ai-stack/data 2>/dev/null || true
    chown -R 1001:1001 /srv/ai-stack/data 2>/dev/null || c_yellow "    ⚠ chown 1001 a échoué (pas root, pas sudo)"
    chmod 755 /srv/ai-stack/data 2>/dev/null || true
  fi
}

deploy_stack() {
  local env_file="${SCRIPT_DIR}/.env"
  [[ -f "$env_file" ]] || { c_red "  ✗ .env manquant à $env_file"; return 1; }
  set -a; . "$env_file"; set +a

  prepare_app_data_dirs

  c_blue "  → Création des réseaux Docker partagés..."
  # 2 networks externes utilisés par plusieurs composes :
  #   - aibox_net (par défaut, override via NETWORK_NAME)
  #   - ollama_net (utilisé par services/inference + services/setup)
  # Sans ça, les composes plantent au démarrage avec :
  #   network ollama_net declared as external, but could not be found
  # Idempotent : `docker network create` exit 1 si existe → ignoré.
  for net in "${NETWORK_NAME:-aibox_net}" ollama_net; do
    if docker network inspect "$net" >/dev/null 2>&1; then
      c_green "    ✓ Network $net existe déjà"
    else
      docker network create "$net" >/dev/null && c_green "    ✓ Network $net créé"
    fi
  done

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
  # --force-recreate : Ollama a un container_name fixe ('ollama') qui peut
  # exister depuis un précédent deploy AVEC un compose différent (ex: sans
  # runtime: nvidia → GPU pas vu). Sans --force-recreate, compose réutilise
  # le container existant et les modifs du compose sont ignorées.
  ( cd services/inference && docker compose --env-file "$env_file" up -d --force-recreate ) || \
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

  # ---- Migrations DB (best-effort) ------------------------------------------
  # Re-joue les migrations versionnées (tools/migrations/0001-0009...).
  # Idempotent grâce au flag is_applied() de chaque migration. Best-effort
  # car certaines exigent Dify déjà up (le polling ci-dessus ne garantit
  # pas que Dify ait fini son schema migration avant qu'on les appelle).
  if [[ -f tools/migrations/run-pending.py ]]; then
    c_blue "  → Application des migrations versionnées..."
    ( set -a; . "$env_file"; set +a; \
      DIFY_CONSOLE_API="${DIFY_CONSOLE_API:-http://localhost:8081/console/api}" \
      python3 tools/migrations/run-pending.py ) || \
      c_yellow "    (Migrations partiellement échouées — relancer plus tard avec ./tools/migrations/run-pending.py)"
  fi
}

# ---- Provisioning des master credentials BoxIA (Cloudflare, etc.) ----------
#
# Pourquoi : sur une box neuve, le wizard de premier démarrage doit pouvoir
# masquer la section "credentials Cloudflare" et ne demander au CLIENT que le
# sous-domaine (ex: "acme" → acme.ialocal.pro). Pour ça, le container wizard
# (cf. services/setup/docker-compose.yml) lit /etc/aibox-master/cloudflare.env
# au démarrage. Si ce fichier existe, le wizard saute la section credentials.
#
# Cette fonction écrit /etc/aibox-master/cloudflare.env si — et seulement si —
# les variables CF_MASTER_* sont définies dans l'environnement qui lance ce
# script. Workflow type :
#
#   # Sur ta machine (Andre) :
#   source ~/.boxia/master-creds.env  # contient CF_MASTER_ACCOUNT_ID, etc.
#   scp -r . root@new-box:/srv/ai-stack/
#   ssh root@new-box "cd /srv/ai-stack && CF_MASTER_ACCOUNT_ID=$CF_MASTER_ACCOUNT_ID \
#     CF_MASTER_TUNNEL_ID=$CF_MASTER_TUNNEL_ID \
#     CF_MASTER_API_TOKEN=$CF_MASTER_API_TOKEN \
#     CF_MASTER_ZONE_ID=$CF_MASTER_ZONE_ID \
#     ./install.sh"
#
# Si les vars sont absentes (cas dev local, ou client qui réinstalle sa propre
# box sans nos credentials BoxIA) → on skippe avec un warning et le wizard
# basculera en mode "demander les credentials au client".
#
# Idempotent : si /etc/aibox-master/cloudflare.env existe déjà, on le réécrit
# (les credentials peuvent avoir été rotés depuis la dernière install). Si on
# ne veut PAS l'écraser, exporter AIBOX_KEEP_EXISTING_MASTER_CREDS=1.
provision_master_creds() {
  local cf_account="${CF_MASTER_ACCOUNT_ID:-}"
  local cf_tunnel="${CF_MASTER_TUNNEL_ID:-}"
  local cf_token="${CF_MASTER_API_TOKEN:-}"
  local cf_zone="${CF_MASTER_ZONE_ID:-}"
  local cf_root="${CF_MASTER_ROOT_DOMAIN:-ialocal.pro}"

  # Aucun credential maître fourni → mode "client autonome"
  if [[ -z "$cf_account" && -z "$cf_tunnel" && -z "$cf_token" && -z "$cf_zone" ]]; then
    if [[ -f /etc/aibox-master/cloudflare.env ]]; then
      c_green "  ✓ Master credentials Cloudflare déjà présents (/etc/aibox-master/cloudflare.env), conservés"
    else
      c_yellow "  ⚠ Pas de master credentials Cloudflare fournis (CF_MASTER_*)"
      c_yellow "    → Le wizard demandera les 4 IDs Cloudflare au client lui-même."
      c_yellow "    → Pour les pré-injecter (ce que BoxIA fait avant livraison), relance avec :"
      c_yellow "      CF_MASTER_ACCOUNT_ID=... CF_MASTER_TUNNEL_ID=... \\\\"
      c_yellow "      CF_MASTER_API_TOKEN=... CF_MASTER_ZONE_ID=... ./install.sh"
    fi
    return 0
  fi

  # Au moins un credential fourni → on exige les 4 obligatoires (root_domain optionnel)
  local missing=()
  [[ -z "$cf_account" ]] && missing+=("CF_MASTER_ACCOUNT_ID")
  [[ -z "$cf_tunnel" ]]  && missing+=("CF_MASTER_TUNNEL_ID")
  [[ -z "$cf_token" ]]   && missing+=("CF_MASTER_API_TOKEN")
  [[ -z "$cf_zone" ]]    && missing+=("CF_MASTER_ZONE_ID")
  if [[ ${#missing[@]} -gt 0 ]]; then
    c_red "  ✗ Provisioning master creds incomplet — variables manquantes : ${missing[*]}"
    c_red "    Soit fournis les 4 (account/tunnel/token/zone), soit aucune."
    exit 1
  fi

  # Si le fichier existe et qu'on ne veut pas l'écraser → skip
  if [[ -f /etc/aibox-master/cloudflare.env && "${AIBOX_KEEP_EXISTING_MASTER_CREDS:-0}" == "1" ]]; then
    c_yellow "  ⚠ /etc/aibox-master/cloudflare.env existe et AIBOX_KEEP_EXISTING_MASTER_CREDS=1 → préservé"
    return 0
  fi

  c_blue "  → Provisioning /etc/aibox-master/cloudflare.env (master Cloudflare BoxIA)..."

  # On a besoin de root pour écrire dans /etc/. Détection du contexte :
  # - Si on est root (UID 0) : pas de sudo
  # - Sinon : sudo (qui peut prompter le mot de passe en interactif)
  local SUDO=""
  if [[ "$(id -u)" -ne 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      c_red "  ✗ Ni root, ni sudo disponible. Impossible d'écrire /etc/aibox-master/."
      exit 1
    fi
    SUDO="sudo"
  fi

  # Mode 755 dossier : permet aux non-root de faire test -f cloudflare.env
  $SUDO install -d -m 755 -o root -g root /etc/aibox-master

  # Atomic write via fichier temporaire + rename, comme ça pas de fenêtre
  # où le fichier serait partiellement écrit pendant qu'un container le lit.
  local tmpfile
  tmpfile=$(mktemp)
  cat > "$tmpfile" <<EOF
# /etc/aibox-master/cloudflare.env
# Master credentials Cloudflare BoxIA — généré par install.sh le $(date -Iseconds)
# Ne pas commit, ne pas partager. Survit aux resets clients (hors /srv/ai-stack/).
CF_DEFAULT_ACCOUNT_ID=$cf_account
CF_DEFAULT_TUNNEL_ID=$cf_tunnel
CF_DEFAULT_API_TOKEN=$cf_token
CF_DEFAULT_ZONE_ID=$cf_zone
CF_DEFAULT_ROOT_DOMAIN=$cf_root
EOF
  # Mode 640 root:docker pour que docker-compose CLIENT puisse lire le
  # fichier (cf. provision-master-creds.sh pour le détail). Fallback 600
  # root:root si le group docker n'existe pas.
  if getent group docker >/dev/null 2>&1; then
    $SUDO install -m 640 -o root -g docker "$tmpfile" /etc/aibox-master/cloudflare.env
  else
    $SUDO install -m 600 -o root -g root "$tmpfile" /etc/aibox-master/cloudflare.env
  fi
  rm -f "$tmpfile"

  c_green "  ✓ Master Cloudflare credentials écrits (root:root 600, $(echo "$cf_token" | wc -c | awk '{print $1-1}') chars token)"
  c_green "    Le wizard masquera la section credentials et ne demandera que le sous-domaine."
}

# ---- Mode non-interactif (utilisé par le wizard web ou CI) -----------------
# Note : provision_master_creds n'est appelée QUE en mode interactif. En mode
# non-interactif, install.sh tourne dans le container du wizard (qui n'a pas
# /etc/aibox-master/ monté) et de toute façon les CF_DEFAULT_* ont déjà été
# lues par le container au démarrage (env_file dans services/setup/docker-compose.yml).
# Provisionner les master creds est une étape "préparation hardware par BoxIA",
# pas une étape "déploiement runtime par le client".
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
# En mode BOOTSTRAP (deploy-new-box.sh), pas de `clear` : on veut conserver les
# logs SSH précédents (Docker install, code push, etc.) pour que l'opérateur
# voie tout l'historique en cas de pépin.
if [[ "${AIBOX_BOOTSTRAP:-0}" != "1" ]]; then
  clear
fi
c_green "╔══════════════════════════════════════════════════════════════════╗"
if [[ "${AIBOX_BOOTSTRAP:-0}" == "1" ]]; then
c_green "║          AI BOX — Bootstrap automatique (zero-question)           ║"
else
c_green "║              AI BOX — Installation interactive                    ║"
fi
c_green "╚══════════════════════════════════════════════════════════════════╝"
echo
if [[ "${AIBOX_BOOTSTRAP:-0}" == "1" ]]; then
  c_yellow "Mode bootstrap : toutes les questions seront auto-répondues avec"
  c_yellow "les valeurs par défaut. Le wizard web (port 80) collectera les"
  c_yellow "vraies valeurs auprès du client et écrasera ce .env initial."
else
  c_yellow "Cet assistant va configurer votre serveur IA local."
  c_yellow "Toutes les valeurs sont modifiables après installation dans .env"
fi
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
# Provisionne /etc/aibox-master/cloudflare.env si CF_MASTER_* sont set dans
# l'env qui lance install.sh (c'est le moment "préparation hardware par BoxIA",
# avant livraison au client). Sinon, simple warning et on continue → le wizard
# basculera en mode "demander les credentials au client".
provision_master_creds
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
# Plugin Daemon (Dify ≥1.x) : 2 secrets distincts requis. Sans eux le
# container aibox-dify-plugin-daemon plante au boot avec :
#   invalid configuration: Field validation for 'ServerKey' failed on 'required'
#   invalid configuration: Field validation for 'DifyInnerApiKey' failed on 'required'
# Cf services/dify/docker-compose.yml — vars SERVER_KEY et INNER_API_KEY_FOR_PLUGIN.
DIFY_PLUGIN_DAEMON_KEY=$(gen_secret 48)
DIFY_INNER_API_KEY=$(gen_secret 48)
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
# Shared secret entre aibox-app (Next.js) et les workers connecteurs Python.
# Les workers (rag-gdrive, rag-msgraph) le présentent dans X-Connector-Token
# pour récupérer un access_token OAuth déchiffré via /api/oauth/internal/token.
# Cf services/app/src/lib/connector-tool-helpers.ts et services/connectors/_lib/oauth.py.
CONNECTOR_INTERNAL_TOKEN=$(gen_secret 48)
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
DIFY_PLUGIN_DAEMON_KEY=${DIFY_PLUGIN_DAEMON_KEY}
DIFY_INNER_API_KEY=${DIFY_INNER_API_KEY}
QDRANT_API_KEY=${QDRANT_API_KEY}

# ----- SIDECARS & CONNECTEURS (auto-générés, ne PAS modifier) -----
AGENTS_API_KEY=${AGENTS_API_KEY}
MEM0_API_KEY=${MEM0_API_KEY}
FEC_TOOL_API_KEY=${FEC_TOOL_API_KEY}
PENNYLANE_TOOL_API_KEY=${PENNYLANE_TOOL_API_KEY}
GLPI_TOOL_API_KEY=${GLPI_TOOL_API_KEY}
ODOO_TOOL_API_KEY=${ODOO_TOOL_API_KEY}
TEXT2SQL_TOOL_API_KEY=${TEXT2SQL_TOOL_API_KEY}
CONNECTOR_INTERNAL_TOKEN=${CONNECTOR_INTERNAL_TOKEN}
N8N_PASSWORD=${N8N_PASSWORD}

# ----- OAUTH PROVIDERS (Google Drive/Gmail/Calendar + Microsoft Graph) -----
# Les credentials viennent de Google Cloud Console + Microsoft Entra. Si
# vide, les boutons « Connecter avec Google/Microsoft » de /connectors
# affichent l'aide d'installation. Cf docs/oauth-setup.md.
# OAUTH_REDIRECT_BASE_URL doit être l'URL HTTPS publique (Cloudflare Tunnel
# ou DNS) du serveur AI Box — utilisée pour construire le redirect_uri
# enregistré côté provider. tools/configure-aibox-domain.sh la patch quand
# l'admin choisit un domaine.
OAUTH_REDIRECT_BASE_URL=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
# Mode auth pour les workers connecteurs RAG. Par défaut 'oauth' (utilise
# le token User OAuth saisi via /connectors UI). Mettre 'service_account'
# (gdrive) ou 'client_credentials' (msgraph) pour le mode legacy.
RAG_GDRIVE_AUTH_MODE=oauth
RAG_MSGRAPH_AUTH_MODE=oauth

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
# GID du group docker host — utilisé par services/app/docker-compose.yml
# (group_add) pour que le user nextjs:1001 du container puisse parler à
# /var/run/docker.sock (sync-status, sync-now). Auto-détecté ici.
DOCKER_GID=$( ( getent group docker 2>/dev/null | cut -d: -f3 | grep -E '^[0-9]+$' ) || echo 988 )

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

# En mode BOOTSTRAP : démarre AUSSI le wizard (services/setup) sur ${SETUP_PORT:-80}.
# Sans ça, le client n'a pas d'UI pour renseigner ses vraies infos après le
# bootstrap → la box reste avec les valeurs placeholder ("Acme SARL", etc.).
# Variable SETUP_PORT permet d'overrider le port (utile si :80 est déjà pris,
# ex: par Nextcloud sur xefia → SETUP_PORT=8080).
if [[ "${AIBOX_BOOTSTRAP:-0}" == "1" ]]; then
  hr
  c_blue "  → Démarrage du wizard de setup (services/setup) sur :${SETUP_PORT:-80}..."
  # Networks aibox_net + ollama_net déjà créés par deploy_stack juste avant.
  # --build : sans ça, docker compose réutilise l'image existante et ignore
  # tout changement dans services/setup/app/ (main.py, templates/, etc.).
  # Pas idéal pour la perf au 2e deploy, mais essentiel pour qu'un fix de
  # bug dans le wizard soit pris en compte sans manipuler les images.
  if ( cd services/setup && SETUP_PORT="${SETUP_PORT:-80}" \
       docker compose --env-file ../../.env up -d --build ); then
    c_green "    ✓ Wizard accessible sur http://<box>:${SETUP_PORT:-80}"
    BOOTSTRAP_WIZARD_URL="http://<box>:${SETUP_PORT:-80}"
  else
    c_yellow "    ⚠ Le wizard n'a pas démarré (port ${SETUP_PORT:-80} occupé ?)."
    c_yellow "      Logs    : docker logs aibox-setup-caddy"
    c_yellow "      Retry   : SETUP_PORT=<autre> ./install.sh"
    BOOTSTRAP_WIZARD_URL=""
  fi
fi

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
echo "    4. (Optionnel) Brancher Google/Microsoft :"
echo "       a. Créer un OAuth Client ID dans console.cloud.google.com /"
echo "          entra.microsoft.com (tools/configure-aibox-domain.sh imprime"
echo "          la procédure complète)."
echo "       b. Renseigner GOOGLE_OAUTH_CLIENT_ID + SECRET (resp. MICROSOFT_*)"
echo "          dans .env, puis ./install.sh (idempotent) ou redémarrer"
echo "          aibox-app pour recharger les vars."
echo "       c. Dans /connectors, cliquer « Connecter avec Google » sur"
echo "          Google Drive — un consent popup s'ouvre. Idem pour OneDrive."
echo "       d. Le worker correspondant se déclenche au 1er sync :"
echo "          tools/start-connector.sh rag-gdrive --rebuild"
echo "          tools/start-connector.sh rag-msgraph --rebuild"
echo
c_blue "💾 Configuration sauvegardée dans : client_config.yaml"
c_blue "🚀 Pour mettre à jour : ./update.sh"
echo
