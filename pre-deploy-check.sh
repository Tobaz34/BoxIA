#!/usr/bin/env bash
# =============================================================================
# AI Box — Pre-deploy check
# =============================================================================
# À lancer AVANT un reset/déploiement pour valider que tout est en place.
# Retourne exit 0 si tout est OK, exit 1 sinon.
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

c_ok()   { printf "\033[1;32m✓\033[0m  %s\n" "$*"; }
c_ko()   { printf "\033[1;31m✗\033[0m  %s\n" "$*"; }
c_warn() { printf "\033[1;33m⚠\033[0m  %s\n" "$*"; }
c_blue() { printf "\033[1;34m▶\033[0m  %s\n" "$*"; }

ERRORS=0
WARNS=0

check_ok()   { c_ok   "$1"; }
check_ko()   { c_ko   "$1"; ERRORS=$((ERRORS+1)); }
check_warn() { c_warn "$1"; WARNS=$((WARNS+1)); }

echo "════════════════════════════════════════════════════════════════════"
echo "  Pre-deploy check — vérification avant reset/déploiement"
echo "════════════════════════════════════════════════════════════════════"

# ----- 1. Système -----
c_blue "Système"
command -v docker >/dev/null && check_ok "docker installé ($(docker --version | awk '{print $3}' | tr -d ','))" || check_ko "docker absent"
docker compose version >/dev/null 2>&1 && check_ok "docker compose v2 disponible" || check_ko "docker compose v2 absent"
command -v nvidia-smi >/dev/null 2>&1 && check_ok "nvidia-smi présent ($(nvidia-smi --query-gpu=name --format=csv,noheader | head -1))" || check_warn "pas de GPU NVIDIA détectée (CPU only — lent)"

# ----- 2. Networks Docker -----
c_blue "Networks Docker"
docker network ls --format '{{.Name}}' | grep -qx aibox_net  && check_ok "réseau aibox_net existe" || check_warn "aibox_net absent (sera créé au déploiement)"
docker network ls --format '{{.Name}}' | grep -qx ollama_net && check_ok "réseau ollama_net existe (compat stack héritée)" || check_warn "ollama_net absent — services/inference pourrait échouer"

# ----- 3. Volumes critiques -----
c_blue "Volumes critiques (préservés au reset)"
for v in anythingllm_ollama_data anythingllm_open-webui; do
    if docker volume ls --format '{{.Name}}' | grep -qx "$v"; then
        size=$(docker run --rm -v "$v":/data alpine du -sh /data 2>/dev/null | awk '{print $1}')
        check_ok "$v présent ($size)"
    else
        check_warn "$v absent (sera créé vide à l'install — modèles à re-pull)"
    fi
done

# ----- 4. Modèles Ollama -----
c_blue "Modèles Ollama"
if docker ps --format '{{.Names}}' | grep -qx ollama; then
    for m in qwen2.5:7b bge-m3 mistral; do
        if docker exec ollama ollama list 2>/dev/null | grep -q "^$m"; then
            check_ok "modèle $m présent"
        else
            check_warn "modèle $m absent (à pull post-déploiement)"
        fi
    done
    if docker exec ollama ollama list 2>/dev/null | grep -q "llama-guard3"; then
        check_ok "modèle llama-guard3 présent (sécurité)"
    else
        check_warn "modèle llama-guard3 absent (Llama Guard utilisera fallback heuristiques)"
    fi
else
    check_warn "container ollama non démarré (sera démarré à l'install)"
fi

# ----- 5. Composes valides -----
c_blue "Composes valides"
for d in services/authentik services/dify services/inference services/edge services/setup services/monitoring services/security/llama-guard; do
    if [[ -f "$d/docker-compose.yml" ]]; then
        if (cd "$d" && docker compose --env-file ../../.env config --quiet 2>/dev/null) || \
           (cd "$d" && docker compose --env-file ../../../.env config --quiet 2>/dev/null); then
            check_ok "$d valide"
        else
            check_ko "$d compose ne valide pas (vérifier --env-file)"
        fi
    else
        check_warn "$d/docker-compose.yml absent"
    fi
done

# ----- 6. Wizard de setup actif -----
c_blue "Wizard de setup"
if docker ps --format '{{.Names}}' | grep -qx aibox-setup-caddy; then
    check_ok "container aibox-setup-caddy actif"
    if curl -sf -o /dev/null http://127.0.0.1:${SETUP_PORT:-8090}/api/state; then
        check_ok "endpoint /api/state répond"
    else
        check_ko "endpoint wizard ne répond pas (port ${SETUP_PORT:-8090})"
    fi
else
    check_warn "wizard de setup non démarré — sera relancé au reset"
fi

# ----- 7. install.sh non-interactif -----
c_blue "install.sh"
if grep -q "AIBOX_NONINTERACTIVE" install.sh; then
    check_ok "install.sh supporte AIBOX_NONINTERACTIVE=1"
else
    check_ko "install.sh n'a PAS de mode non-interactif — le wizard ne pourra pas déployer"
fi
[[ -x install.sh ]] && check_ok "install.sh exécutable" || check_warn "install.sh non exécutable (chmod +x)"

# ----- 8. Espace disque -----
c_blue "Espace disque"
avail_gb=$(df -BG / | awk 'NR==2{gsub(/G/,"",$4); print $4}')
if (( avail_gb > 50 )); then
    check_ok "${avail_gb} GB libres sur /"
else
    check_warn "${avail_gb} GB libres seulement (recommandé > 50 GB)"
fi

# ----- 9. Backups -----
c_blue "Backups"
if [[ -d /srv/aibox-backups ]] && [[ -n "$(ls -A /srv/aibox-backups 2>/dev/null)" ]]; then
    last=$(ls -1t /srv/aibox-backups | head -1)
    check_ok "dernier backup : $last"
else
    check_warn "aucun backup encore (lance ./backup.sh avant reset)"
fi

# ----- Verdict -----
echo
echo "════════════════════════════════════════════════════════════════════"
if (( ERRORS == 0 )); then
    if (( WARNS == 0 )); then
        printf "\033[1;32m✓ READY — tout est OK, tu peux faire ./reset-as-client.sh\033[0m\n"
    else
        printf "\033[1;33m⚠ READY — %d warning(s) non bloquants, tu peux y aller\033[0m\n" "$WARNS"
    fi
    exit 0
else
    printf "\033[1;31m✗ BLOCKED — %d erreur(s) à corriger avant deploy\033[0m\n" "$ERRORS"
    exit 1
fi
