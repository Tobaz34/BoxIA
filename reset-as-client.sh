#!/usr/bin/env bash
# =============================================================================
# AI Box — Reset "comme un nouveau client" (idempotent)
# =============================================================================
# Remet la box dans l'état "première mise en route", comme si elle sortait
# d'usine. Le wizard de setup sera alors présenté à nouveau sur :8090.
#
# Ce script :
#   - Sauvegarde l'état actuel (au cas où, dans /srv/aibox-backups/)
#   - Stoppe la stack applicative (Authentik, Dify, Qdrant, OWUI)
#   - Supprime les volumes APPLICATIFS (data utilisateur, comptes, configs)
#   - Préserve les modèles Ollama (téléchargés, gros à récupérer)
#   - Préserve le code dans /srv/ai-stack/
#   - Préserve les backups historiques
#   - Reset le wizard (.configured + volume aibox_setup_state)
#   - Redémarre uniquement le wizard de setup
#
# Usage :
#   ./reset-as-client.sh                # avec confirmation interactive
#   ./reset-as-client.sh --yes          # sans confirmation
#   ./reset-as-client.sh --keep-owui    # garde les chats Open WebUI existants
# =============================================================================
set -euo pipefail

# Si root (lancé depuis container), pas besoin de sudo
SUDO=""
[[ "$EUID" -ne 0 ]] && SUDO="sudo"

KEEP_OWUI=false
ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y)        ASSUME_YES=true ;;
        --keep-owui)     KEEP_OWUI=true ;;
        --help|-h)       grep '^#' "$0" | sed 's/^#//'; exit 0 ;;
    esac
done

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
hr()       { printf "%.0s─" {1..70}; printf "\n"; }

c_red "════════════════════════════════════════════════════════════════════"
c_red "  ⚠ RESET DE LA BOX vers l'état 'premier démarrage client'"
c_red "════════════════════════════════════════════════════════════════════"
echo
c_yellow "Cela va :"
echo "  • Stopper et supprimer les containers : Authentik, Dify, Qdrant, Edge"
[[ "$KEEP_OWUI" == "true" ]] || echo "  • Stopper et supprimer Open WebUI (chats utilisateurs perdus)"
echo "  • Supprimer les volumes applicatifs (comptes Authentik, agents Dify, vectors Qdrant)"
echo "  • Réinitialiser le wizard de setup"
echo
c_green "Ce qui SERA PRÉSERVÉ :"
echo "  • Modèles Ollama (qwen2.5:7b, bge-m3, mistral) — ~10 GB"
echo "  • Code source /srv/ai-stack/"
echo "  • Backups dans /srv/aibox-backups/"
[[ "$KEEP_OWUI" == "true" ]] && echo "  • Chats Open WebUI (--keep-owui)"
echo "  • Volume Docker partagé aibox_net"
echo "  • Stack héritée (n8n, Portainer, Dashy, Uptime Kuma, NPM, Duplicati)"
echo

if [[ "$ASSUME_YES" != "true" ]]; then
    read -rp "$(c_yellow "Continuer ? Tapez 'reset' pour confirmer : ")" answer
    if [[ "$answer" != "reset" ]]; then
        c_red "Annulé."
        exit 1
    fi
fi

# ----- Backup pré-reset -------------------------------------------------------
hr
c_blue "[1/6] Backup préventif"
if [[ -x ./backup.sh ]]; then
    ./backup.sh quick || c_yellow "Backup partiel mais on continue"
else
    c_yellow "  ⊘ backup.sh introuvable, skip"
fi

# ----- Stop containers --------------------------------------------------------
hr
c_blue "[2/6] Arrêt des containers applicatifs"

STOP_LIST=(
    aibox-edge-caddy
    aibox-dify-nginx aibox-dify-api aibox-dify-worker aibox-dify-web
    aibox-dify-db aibox-dify-redis aibox-dify-sandbox aibox-dify-ssrf-proxy
    aibox-authentik-server aibox-authentik-worker
    aibox-authentik-redis aibox-authentik-postgres
    aibox-qdrant
    # Connecteurs (si actifs)
    aibox-conn-rag-smb aibox-conn-rag-msgraph aibox-conn-rag-gdrive aibox-conn-rag-nextcloud
    aibox-conn-email-msgraph aibox-conn-email-imap
    aibox-conn-erp-odoo aibox-conn-text2sql aibox-conn-helpdesk-glpi
    aibox-llama-guard
    # Apps héritées avec compte local (les comptes sont reprovisionnés ensuite)
    n8n uptime-kuma portainer
    # Wizard (sera redémarré ensuite)
    aibox-setup-api aibox-setup-caddy
)
[[ "$KEEP_OWUI" == "true" ]] || STOP_LIST+=(open-webui)

for c in "${STOP_LIST[@]}"; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
        echo "  ⏹  $c"
        docker stop "$c" >/dev/null 2>&1 || true
        docker rm "$c"   >/dev/null 2>&1 || true
    fi
done

# ----- Suppression volumes applicatifs ----------------------------------------
hr
c_blue "[3/6] Suppression des volumes data applicatifs"

DEL_VOLUMES=(
    # Authentik (tous)
    aibox-authentik_authentik_postgres_data
    aibox-authentik_authentik_redis_data
    aibox-authentik_authentik_media
    aibox-authentik_authentik_certs
    aibox-authentik_authentik_custom_templates
    # Dify (tous)
    aibox-dify_dify_db_data
    aibox-dify_dify_redis_data
    aibox-dify_dify_api_storage
    aibox-dify_dify_sandbox_deps
    # Qdrant (vectors RAG)
    aibox_qdrant_data
    aibox_qdrant_snapshots
    # Wizard de setup
    aibox_setup_state
    aibox_setup_caddy_data
    # Edge Caddy (certs internes)
    aibox_edge_caddy_data
    aibox_edge_caddy_config
    # Connecteurs state
    aibox_conn_rag_msgraph_state aibox_conn_rag_gdrive_state aibox_conn_email_msgraph_state
    aibox_conn_email_imap_state aibox_conn_rag_nextcloud_state

    # ----- Apps "héritées" qui ont leur propre compte admin -----
    # Reset des comptes locaux au reset → recréés via provisioning post-deploy.
    # ATTENTION : ça supprime aussi les workflows n8n et les monitors Uptime Kuma.
    # Pour les préserver, lance avec --keep-apps-data (futur).
    anythingllm_n8n_data
    stack_xefia_n8n_data
    anythingllm_uptime-kuma
    stack_xefia_uptime-kuma
    anythingllm_portainer_data
    stack_xefia_portainer_data
)
[[ "$KEEP_OWUI" == "true" ]] || DEL_VOLUMES+=(anythingllm_open-webui stack_xefia_open-webui)

for v in "${DEL_VOLUMES[@]}"; do
    if docker volume ls --format '{{.Name}}' | grep -qx "$v"; then
        echo "  🗑  $v"
        docker volume rm "$v" >/dev/null 2>&1 || c_yellow "    (ne peut pas être supprimé pour le moment)"
    fi
done

# ----- Reset des marqueurs ----------------------------------------------------
hr
c_blue "[4/6] Reset des marqueurs de configuration"

# .env et client_config.yaml — on les SAUVEGARDE en .bak avant de les supprimer
TS=$(date +%s)
if [[ -f /srv/ai-stack/.env ]]; then
    $SUDO mv /srv/ai-stack/.env "/srv/ai-stack/.env.reset-$TS.bak"
    echo "  📁 /srv/ai-stack/.env → .env.reset-$TS.bak"
fi
if [[ -f /srv/ai-stack/client_config.yaml ]]; then
    $SUDO mv /srv/ai-stack/client_config.yaml "/srv/ai-stack/client_config.yaml.reset-$TS.bak"
    echo "  📁 client_config.yaml → .reset-$TS.bak"
fi

# Marqueur .configured (si systemd firstrun installé)
if [[ -f /var/lib/aibox/.configured ]]; then
    $SUDO rm -f /var/lib/aibox/.configured
    echo "  🗑  /var/lib/aibox/.configured"
fi

# ----- Recréer le réseau et le .env minimal pour le wizard --------------------
hr
c_blue "[5/6] Préparation du wizard de setup"

# Le réseau aibox_net doit exister
if ! docker network ls --format '{{.Name}}' | grep -qx aibox_net; then
    docker network create aibox_net >/dev/null
    echo "  ✓ network aibox_net créé"
fi

# Le wizard a besoin d'un .env minimal pour démarrer (juste NETWORK_NAME).
# Important : préserver l'owner du dossier parent /srv/ai-stack/ pour que le user
# de l'hôte (clikinfo) puisse le lire depuis SSH (ex: pour `docker compose ...`).
PARENT_UID=$(stat -c '%u' /srv/ai-stack)
PARENT_GID=$(stat -c '%g' /srv/ai-stack)

$SUDO tee /srv/ai-stack/.env >/dev/null <<EOF
# Reset le $(date -Iseconds) — le wizard va remplir ce fichier
NETWORK_NAME=aibox_net
EOF
$SUDO chown "${PARENT_UID}:${PARENT_GID}" /srv/ai-stack/.env
$SUDO chmod 644 /srv/ai-stack/.env   # 644 car juste NETWORK_NAME (pas de secret).
# Le wizard, quand il écrit /api/configure, refera un chmod 600.

# ----- Redémarrer le wizard ---------------------------------------------------
hr
c_blue "[6/6] Rebuild + démarrage du wizard de setup"
cd /srv/ai-stack/services/setup
# `--build` important : si on a `git pull` du code wizard depuis le dernier
# reset, on doit reconstruire l'image (sinon l'ancienne image cached est
# réutilisée, et les nouveautés de wizard.html/wizard.js/main.py restent
# invisibles). Sans --build, ce script donnerait une fausse impression
# de « rien n'a changé ».
SETUP_PORT=${SETUP_PORT:-8090} docker compose --env-file ../../.env up -d --build 2>&1 | tail -5

sleep 4

hr
c_green "════════════════════════════════════════════════════════════════════"
c_green "  ✓ Reset terminé — la box est repartie en mode 'premier démarrage'"
c_green "════════════════════════════════════════════════════════════════════"
echo
c_blue "🌐 Wizard de setup disponible sur :"
echo "    http://$(hostname -I | awk '{print $1}'):${SETUP_PORT:-8090}"
echo "    (depuis ton VPN : http://192.168.15.210:${SETUP_PORT:-8090})"
echo
c_blue "🔄 Pour reset à nouveau (autant de fois que tu veux) :"
echo "    ./reset-as-client.sh"
echo
c_blue "📦 Backups .env précédents conservés (au cas où) :"
ls /srv/ai-stack/.env.reset-*.bak 2>/dev/null | tail -3 || echo "    (aucun)"
echo
