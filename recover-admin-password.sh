#!/usr/bin/env bash
# =============================================================================
# AI Box — Recovery du mot de passe administrateur
# =============================================================================
# À utiliser quand :
#   - Le client a perdu son mot de passe admin
#   - Le wizard a planté avant la création du compte Authentik
#   - On veut rotater le mot de passe admin pour des raisons de sécurité
#
# Reset le mot de passe DANS Authentik (via ak shell) ET dans /srv/ai-stack/.env
# pour que les deux restent synchrones (les futurs `docker compose up -d`
# n'auront pas un mauvais ADMIN_PASSWORD figé).
#
# Usage :
#   sudo ./recover-admin-password.sh                    # prompt interactif
#   sudo ./recover-admin-password.sh "nouveau-mdp"      # non-interactif
#   sudo ./recover-admin-password.sh --user akadmin "nouveau-mdp"
#   sudo ./recover-admin-password.sh --random           # génère un mdp aléatoire
#
# Exit codes : 0 = OK, 1 = erreur user, 2 = erreur Authentik
# =============================================================================
set -euo pipefail

ENV_FILE="/srv/ai-stack/.env"
AUTHENTIK_CONTAINER="aibox-authentik-server"

# ---- Helpers ----------------------------------------------------------------
c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }

# ---- Args -------------------------------------------------------------------
USER_OVERRIDE=""
RANDOM_PWD=false
NEW_PWD=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --user|-u)   USER_OVERRIDE="$2"; shift 2 ;;
        --user=*)    USER_OVERRIDE="${1#--user=}"; shift ;;
        --random|-r) RANDOM_PWD=true; shift ;;
        --help|-h)   sed -n '2,25p' "$0" | sed 's/^# \?//'; exit 0 ;;
        -*)          c_red "Option inconnue: $1"; exit 1 ;;
        *)           NEW_PWD="$1"; shift ;;
    esac
done

# ---- Sanity -----------------------------------------------------------------
if [[ "$EUID" -ne 0 ]]; then
    c_red "Doit être lancé en root (sudo) — accès lecture/écriture .env"
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    c_red "$ENV_FILE introuvable. Box pas encore configurée ?"
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$AUTHENTIK_CONTAINER"; then
    c_red "Container $AUTHENTIK_CONTAINER non démarré."
    c_yellow "Lance d'abord : docker start $AUTHENTIK_CONTAINER"
    exit 2
fi

# ---- Détermine username -----------------------------------------------------
if [[ -n "$USER_OVERRIDE" ]]; then
    USERNAME="$USER_OVERRIDE"
else
    USERNAME=$(grep '^ADMIN_USERNAME=' "$ENV_FILE" | head -1 \
               | cut -d= -f2- | tr -d "'\"")
    if [[ -z "$USERNAME" ]]; then
        c_red "ADMIN_USERNAME absent de .env, utilise --user <login>"
        exit 1
    fi
fi
c_blue "→ Cible : utilisateur '$USERNAME'"

# ---- Détermine mot de passe -------------------------------------------------
if [[ "$RANDOM_PWD" == "true" ]]; then
    NEW_PWD=$(tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 24)
    c_blue "→ Mot de passe aléatoire généré (24 caractères)"
elif [[ -z "$NEW_PWD" ]]; then
    # Prompt interactif
    read -srp "Nouveau mot de passe : " NEW_PWD; echo
    read -srp "Confirme : " NEW_PWD2; echo
    if [[ "$NEW_PWD" != "$NEW_PWD2" ]]; then
        c_red "Mots de passe différents. Abandon."
        exit 1
    fi
    if [[ ${#NEW_PWD} -lt 8 ]]; then
        c_red "Mot de passe trop court (min 8 caractères)."
        exit 1
    fi
fi

# ---- Reset dans Authentik ---------------------------------------------------
c_blue "→ Reset dans Authentik (via ak shell)…"
RESULT=$(USERNAME="$USERNAME" NEW_PWD="$NEW_PWD" \
    docker exec -i -e USERNAME -e NEW_PWD "$AUTHENTIK_CONTAINER" \
    ak shell <<'PY' 2>&1
import os
from authentik.core.models import User
try:
    u = User.objects.get(username=os.environ['USERNAME'])
    u.set_password(os.environ['NEW_PWD'])
    u.save()
    print(f"OK:{u.username}:{u.email}:{'admin' if u.is_superuser else 'user'}")
except User.DoesNotExist:
    print(f"ERR:user_not_found:{os.environ['USERNAME']}")
except Exception as e:
    print(f"ERR:exception:{e}")
PY
)

# Récupère la dernière ligne (résultat)
LAST=$(echo "$RESULT" | grep -E '^(OK|ERR):' | tail -1)
if [[ "$LAST" == OK:* ]]; then
    c_green "  ✓ $LAST"
elif [[ "$LAST" == ERR:* ]]; then
    c_red "  ✗ $LAST"
    exit 2
else
    c_red "  ✗ Sortie inattendue de ak shell:"
    echo "$RESULT" | tail -5
    exit 2
fi

# ---- Met à jour .env --------------------------------------------------------
c_blue "→ Mise à jour de .env (sync avec Authentik)…"
# Échappement bash : ' devient '\''
ESC=$(printf '%s' "$NEW_PWD" | sed "s/'/'\\\\''/g")
if grep -q '^ADMIN_PASSWORD=' "$ENV_FILE"; then
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD='${ESC}'|" "$ENV_FILE"
else
    echo "ADMIN_PASSWORD='${ESC}'" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
c_green "  ✓ .env synchronisé (chmod 600)"

# ---- Backup historique ------------------------------------------------------
mkdir -p /srv/aibox-backups
echo "$(date -Iseconds) reset by $(logname 2>/dev/null || echo unknown) for user='$USERNAME'" \
    >> /srv/aibox-backups/admin-pwd-history.log
chmod 600 /srv/aibox-backups/admin-pwd-history.log

# ---- Affichage final --------------------------------------------------------
echo
c_green "════════════════════════════════════════════════════════════════════"
c_green "  ✓ Mot de passe admin reset"
c_green "════════════════════════════════════════════════════════════════════"
echo
c_blue "  Login    : $USERNAME"
if [[ "$RANDOM_PWD" == "true" ]]; then
    c_yellow "  Password : $NEW_PWD"
    c_yellow "  ⚠ Note-le maintenant — il n'est affiché qu'une fois."
else
    c_blue "  Password : (celui que tu as fourni)"
fi
echo
c_blue "  Connecte-toi sur :"
echo "    https://aibox.local                  (ou le domaine configuré)"
echo "    https://aibox-auth.local/if/admin/   (interface admin Authentik)"
echo
c_blue "  Historique : /srv/aibox-backups/admin-pwd-history.log"
echo
