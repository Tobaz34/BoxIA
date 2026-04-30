#!/usr/bin/env bash
# =============================================================================
# AI Box — Recovery du provisioning OIDC + agents
# =============================================================================
# Utilité : si le wizard a planté en cours de route (typiquement
# create-admin-user en 500 → provision-sso a continué mais sans admin
# token, donc aucun OIDC provider créé, NEXTAUTH_SECRET vide, etc.),
# ce script termine le boulot.
#
# Étapes :
#   1. Vérifie qu'un user admin existe dans Authentik (sinon stop)
#   2. Lance sso_provisioning.provision_all() depuis l'image setup-api
#      (réutilise tout le code Python déjà écrit, idempotent)
#   3. Recreate aibox-app + open-webui pour qu'ils prennent les nouvelles
#      vars OIDC du .env
#
# Usage :
#   sudo ./recover-provisioning.sh
# =============================================================================
set -euo pipefail

ENV_FILE="/srv/ai-stack/.env"
SETUP_IMAGE="aibox-setup-setup-api"

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
hr()       { printf "%.0s─" {1..70}; printf "\n"; }

if [[ "$EUID" -ne 0 ]]; then
    c_red "Doit être lancé en root (sudo) — accès .env"
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    c_red "$ENV_FILE introuvable. Lance le wizard d'abord."
    exit 1
fi

# ---- 1. Check user admin ---------------------------------------------------
hr
c_blue "[1/3] Vérification du user admin Authentik"
USERNAME=$(grep '^ADMIN_USERNAME=' "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")
if [[ -z "$USERNAME" ]]; then
    c_red "ADMIN_USERNAME absent de .env"
    exit 1
fi

ADMIN_OK=$(docker exec -i aibox-authentik-server ak shell <<PY 2>&1 | tail -1
from authentik.core.models import User, Group
g = Group.objects.filter(name='authentik Admins').first()
u = User.objects.filter(username='$USERNAME').first()
print('OK' if u and g and u.ak_groups.filter(pk=g.pk).exists() else 'MISSING')
PY
)
if [[ "$ADMIN_OK" != *OK* ]]; then
    c_red "  ✗ User '$USERNAME' absent ou pas dans 'authentik Admins'."
    c_yellow "  → Lance d'abord : sudo $(dirname "$0")/recover-admin-password.sh"
    exit 1
fi
c_green "  ✓ User '$USERNAME' présent et admin"

# ---- 2. Re-run sso_provisioning.provision_all() -----------------------------
hr
c_blue "[2/3] Provisioning OIDC + comptes Dify/n8n/OWUI"

# Vérifie que l'image setup-api existe (sinon build local)
if ! docker images --format '{{.Repository}}' | grep -qx "$SETUP_IMAGE"; then
    c_yellow "  → image $SETUP_IMAGE absente, build local…"
    docker compose -f /srv/ai-stack/services/setup/docker-compose.yml \
        --env-file "$ENV_FILE" build setup-api 2>&1 | tail -3
fi

# Récupère le hostname public/lan pour les redirect URIs
HOST=$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")
[[ -z "$HOST" ]] && HOST="localhost"

REPORT=$(docker run --rm \
    --network host \
    -v /srv/ai-stack:/srv/ai-stack \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -w /app \
    "$SETUP_IMAGE" \
    python -c "
import sys, json
sys.path.insert(0, '/app')
import sso_provisioning
env = {}
with open('/srv/ai-stack/.env') as f:
    for line in f:
        if '=' in line and not line.startswith('#'):
            k, _, v = line.partition('=')
            env[k.strip()] = v.strip().strip(chr(34)).strip(chr(39))
result = sso_provisioning.provision_all(env, '$HOST')
print(json.dumps(result, indent=2, default=str))
")

echo "$REPORT"
echo

# ---- 3. Recreate aibox-app + open-webui pour prendre les nouvelles vars ----
hr
c_blue "[3/3] Recreate aibox-app + open-webui (avec nouvelles vars OIDC)"

for compose_dir in services/app services/inference; do
    name=$(basename "$compose_dir")
    if [[ -f "/srv/ai-stack/$compose_dir/docker-compose.yml" ]]; then
        echo ""
        echo "  → $compose_dir"
        ( cd "/srv/ai-stack/$compose_dir" && \
          docker compose --env-file "$ENV_FILE" up -d --build 2>&1 | tail -5 )
    fi
done

hr
c_green "════════════════════════════════════════════════════════════════════"
c_green "  ✓ Recovery terminée"
c_green "════════════════════════════════════════════════════════════════════"
echo
c_blue "  → Vérifie le login : https://aibox.local"
c_blue "  → Logs aibox-app si problème : docker logs aibox-app --tail 30"
echo
