#!/usr/bin/env bash
# =============================================================================
# AI Box — Mise à jour sécurisée
# =============================================================================
# Procédure : backup → pull → up -d (sans --force-recreate jamais)
#
# Important: cette procédure NE recrée PAS les containers à moins que l'image
# ait changé. Pas de risque de remontage de volumes vides comme l'incident
# du 2026-04-28.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }

if [[ ! -f .env ]]; then
  c_red "Pas de .env. Lance ./install.sh d'abord."
  exit 1
fi

c_blue "════════════════════════════════════════════════════════════"
c_blue "  AI Box — Mise à jour"
c_blue "════════════════════════════════════════════════════════════"

# 1. Backup pré-MAJ
c_blue "[1/4] Backup préventif..."
./backup.sh quick

# 2. Pull nouvelles images
c_blue "[2/4] Pull des nouvelles images..."
docker compose --env-file .env pull
( cd services/inference && docker compose --env-file ../../.env pull )
( cd services/authentik && docker compose --env-file ../../.env pull )
( cd services/dify && docker compose --env-file ../../.env pull )

# 3. Restart en place (RECREATE seulement si image changée — comportement par défaut compose)
c_blue "[3/4] Application des mises à jour..."
docker compose --env-file .env up -d --remove-orphans
( cd services/inference && docker compose --env-file ../../.env up -d --remove-orphans )
( cd services/authentik && docker compose --env-file ../../.env up -d --remove-orphans )
( cd services/dify && docker compose --env-file ../../.env up -d --remove-orphans )

# 4. Vérifications
c_blue "[4/4] Vérifications..."
sleep 5
docker ps --filter 'name=aibox' --format 'table {{.Names}}\t{{.Status}}'
echo
docker ps --filter 'name=ollama' --filter 'name=open-webui' --format 'table {{.Names}}\t{{.Status}}'

c_green "════════════════════════════════════════════════════════════"
c_green "  ✓ Mise à jour terminée"
c_green "════════════════════════════════════════════════════════════"
