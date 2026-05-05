#!/usr/bin/env bash
# =============================================================================
# tools/provision-master-creds.sh
# -----------------------------------------------------------------------------
# Pousse les master credentials BoxIA (Cloudflare, etc.) sur une box DÉJÀ
# installée, via SSH. Compagnon de la fonction provision_master_creds() qui
# vit dans install.sh — utile quand :
#   - tu as oublié d'exporter les CF_MASTER_* lors de l'install initiale
#   - tu rotes les credentials Cloudflare (master token compromis, etc.)
#   - tu as une box déployée par un client et tu veux y pousser TES creds
#     a posteriori (ex: xefia, qui a été installée avant l'existence de cette
#     fonctionnalité)
#
# Usage :
#   # 1. Sur ta machine, prépare un fichier ~/.boxia/master-creds.env :
#   #    CF_MASTER_ACCOUNT_ID=99f48610a64280...
#   #    CF_MASTER_TUNNEL_ID=856614f1-ed96-...
#   #    CF_MASTER_API_TOKEN=cfut_...
#   #    CF_MASTER_ZONE_ID=6d39b6561b01ac...
#   #    CF_MASTER_ROOT_DOMAIN=ialocal.pro
#   #    chmod 600 ~/.boxia/master-creds.env
#
#   # 2. Lance ce script en passant la cible SSH :
#   ./tools/provision-master-creds.sh clikinfo@192.168.15.210
#   # ou avec un autre fichier de creds :
#   CREDS_FILE=~/.boxia/staging-creds.env ./tools/provision-master-creds.sh root@new-box
#
# Sécu :
#   - Le fichier ~/.boxia/master-creds.env doit être en mode 600 (vérifié)
#   - Le token est passé via stdin SSH (pas en argv visible dans `ps aux`)
#   - Le fichier final sur la box est mode 600 root:root
#
# Idempotent : relancer remplace le fichier (c'est ce qu'on veut quand on rote).
# =============================================================================
set -euo pipefail

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*" >&2; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*" >&2; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*" >&2; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }

# ---- Argument parsing -------------------------------------------------------
if [[ $# -lt 1 ]]; then
  c_red "Usage : $0 <ssh-target>"
  c_red "Exemple : $0 clikinfo@192.168.15.210"
  c_red ""
  c_red "Variables optionnelles :"
  c_red "  CREDS_FILE    Chemin du fichier creds local (default: ~/.boxia/master-creds.env)"
  c_red "  SUDO_PASS     Si la box demande un mot de passe sudo non-NOPASSWD,"
  c_red "                exporter SUDO_PASS=... avant de lancer (sera passé via stdin)"
  exit 1
fi

SSH_TARGET="$1"
CREDS_FILE="${CREDS_FILE:-$HOME/.boxia/master-creds.env}"

# ---- Vérifs locales ---------------------------------------------------------
if [[ ! -f "$CREDS_FILE" ]]; then
  c_red "✗ Fichier creds introuvable : $CREDS_FILE"
  c_red "  Crée-le avec ce contenu (chmod 600) :"
  c_red "    CF_MASTER_ACCOUNT_ID=..."
  c_red "    CF_MASTER_TUNNEL_ID=..."
  c_red "    CF_MASTER_API_TOKEN=..."
  c_red "    CF_MASTER_ZONE_ID=..."
  c_red "    CF_MASTER_ROOT_DOMAIN=ialocal.pro"
  exit 1
fi

# Vérif permissions du fichier creds (on tolère 600 ou 400 ; tout le reste = warning)
PERMS=$(stat -c '%a' "$CREDS_FILE" 2>/dev/null || stat -f '%OLp' "$CREDS_FILE" 2>/dev/null || echo "?")
if [[ "$PERMS" != "600" && "$PERMS" != "400" ]]; then
  c_yellow "⚠ $CREDS_FILE est en mode $PERMS — recommandé : chmod 600 $CREDS_FILE"
fi

# Source le fichier (variables CF_MASTER_*)
# shellcheck disable=SC1090
set -a; source "$CREDS_FILE"; set +a

# Vérifie qu'on a tout ce qu'il faut
missing=()
[[ -z "${CF_MASTER_ACCOUNT_ID:-}" ]] && missing+=("CF_MASTER_ACCOUNT_ID")
[[ -z "${CF_MASTER_TUNNEL_ID:-}" ]]  && missing+=("CF_MASTER_TUNNEL_ID")
[[ -z "${CF_MASTER_API_TOKEN:-}" ]]  && missing+=("CF_MASTER_API_TOKEN")
[[ -z "${CF_MASTER_ZONE_ID:-}" ]]    && missing+=("CF_MASTER_ZONE_ID")
if [[ ${#missing[@]} -gt 0 ]]; then
  c_red "✗ Variables manquantes dans $CREDS_FILE : ${missing[*]}"
  exit 1
fi

CF_MASTER_ROOT_DOMAIN="${CF_MASTER_ROOT_DOMAIN:-ialocal.pro}"

c_blue "→ Cible SSH      : $SSH_TARGET"
c_blue "→ Fichier creds  : $CREDS_FILE"
c_blue "→ Root domain    : $CF_MASTER_ROOT_DOMAIN"
c_blue "→ Token (préfixe) : ${CF_MASTER_API_TOKEN:0:8}…${CF_MASTER_API_TOKEN: -4}"

# ---- Vérif rapide de la cible SSH ------------------------------------------
c_blue "→ Test de connectivité SSH..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_TARGET" "true" 2>/dev/null; then
  c_yellow "⚠ Connexion SSH non-batch (probablement mot de passe demandé). Continue, mais"
  c_yellow "  les commandes avec sudo derrière vont peut-être bloquer."
fi

# ---- Validation API Cloudflare AVANT push ----------------------------------
# (Évite de pousser un token cassé qui ne servira à rien)
c_blue "→ Validation du token Cloudflare via /user/tokens/verify..."
if ! curl -sf "https://api.cloudflare.com/client/v4/user/tokens/verify" \
     -H "Authorization: Bearer $CF_MASTER_API_TOKEN" >/dev/null; then
  c_red "✗ Le token Cloudflare est invalide ou expiré. Abandon."
  c_red "  Vérifie sur https://dash.cloudflare.com/profile/api-tokens"
  exit 1
fi
c_green "  ✓ Token valide"

# Sanity check : la zone et le tunnel sont accessibles avec ce token
if ! curl -sf "https://api.cloudflare.com/client/v4/zones/$CF_MASTER_ZONE_ID" \
     -H "Authorization: Bearer $CF_MASTER_API_TOKEN" >/dev/null; then
  c_red "✗ Zone $CF_MASTER_ZONE_ID inaccessible avec ce token."
  c_red "  Vérifie que la zone existe et que le token a Zone:Read sur cette zone."
  exit 1
fi
c_green "  ✓ Zone accessible"

if ! curl -sf "https://api.cloudflare.com/client/v4/accounts/$CF_MASTER_ACCOUNT_ID/cfd_tunnel/$CF_MASTER_TUNNEL_ID" \
     -H "Authorization: Bearer $CF_MASTER_API_TOKEN" >/dev/null; then
  c_red "✗ Tunnel $CF_MASTER_TUNNEL_ID inaccessible."
  c_red "  Vérifie l'account ID, le tunnel ID, et que le token a Cloudflare Tunnel:Edit."
  exit 1
fi
c_green "  ✓ Tunnel accessible"

# ---- Génère le contenu du fichier ------------------------------------------
# heredoc côté local, qu'on enverra via SSH stdin → le token n'apparaît jamais
# dans une ligne de commande ssh (donc pas dans `ps aux` sur la box distante).
HOSTNAME_TAG=$(uname -n)
TIMESTAMP=$(date -Iseconds 2>/dev/null || date)

CREDS_CONTENT=$(cat <<EOF
# /etc/aibox-master/cloudflare.env
# Master credentials Cloudflare BoxIA — provisionné par tools/provision-master-creds.sh
# depuis $HOSTNAME_TAG le $TIMESTAMP
# Ne pas commit, ne pas partager. Survit aux resets clients (hors /srv/ai-stack/).
CF_DEFAULT_ACCOUNT_ID=$CF_MASTER_ACCOUNT_ID
CF_DEFAULT_TUNNEL_ID=$CF_MASTER_TUNNEL_ID
CF_DEFAULT_API_TOKEN=$CF_MASTER_API_TOKEN
CF_DEFAULT_ZONE_ID=$CF_MASTER_ZONE_ID
CF_DEFAULT_ROOT_DOMAIN=$CF_MASTER_ROOT_DOMAIN
EOF
)

# ---- Push via scp (transfert) + ssh -t (sudo install) ----------------------
# Pourquoi 2 étapes plutôt qu'un ssh unique avec heredoc :
#   - scp ne nécessite pas de sudo (le fichier va dans /tmp/ accessible à tous)
#   - ssh -t ouvre un TTY → permet à sudo de prompter le mot de passe
#     interactivement (cas par défaut quand sudo NOPASSWD n'est pas configuré
#     pour `install` / `chown` sur /etc/aibox-master/)
#   - Si on faisait `ssh + bash -s` avec stdin pour le contenu, sudo n'aurait
#     plus de stdin disponible pour lire le mdp → "sudo: a password is required"
c_blue "→ Push sur $SSH_TARGET ..."

# Local : écrit le contenu dans un temp file
LOCAL_TMP=$(mktemp)
trap 'rm -f "$LOCAL_TMP"' EXIT
echo "$CREDS_CONTENT" > "$LOCAL_TMP"

# Nom unique sur la box distante (PID local pour éviter collision si plusieurs
# provisions simultanées de la part d'opérateurs différents, peu probable mais bon)
REMOTE_TMP="/tmp/aibox-cloudflare.env.$$"

# Transfert (rapide, ~1KB)
scp -q "$LOCAL_TMP" "$SSH_TARGET:$REMOTE_TMP"

# Déplacement avec sudo via ssh -t (TTY pour permettre le prompt sudo).
# IMPORTANT : la commande remote est passée INLINE (pas via heredoc), parce
# que `-t` alloue un PTY et redirige stdin vers ce PTY → un heredoc piperait
# du contenu sur stdin et bloquerait l'allocation TTY ("Pseudo-terminal will
# not be allocated because stdin is not a terminal" + sudo qui plante).
# Quotes : on entoure tout en double-quotes côté local, les `\$` sont expansés
# côté remote, les `$VAR` locaux sont expansés côté local AVANT envoi.
ssh -t "$SSH_TARGET" "
  set -euo pipefail
  if [[ \$(id -u) -eq 0 ]]; then SUDO=''; else SUDO='sudo'; fi
  # Mode 755 sur le dossier (pas 700) pour permettre aux non-root de
  # détecter l'existence du fichier via [[ -f cloudflare.env ]] (qui a besoin
  # de traverse + read sur le dossier parent). Le fichier lui-même reste 600
  # root:root → contenu inaccessible aux non-root. Niveau sécurité :
  # exposer le NOM "cloudflare.env" n'est pas un secret.
  \$SUDO install -d -m 755 -o root -g root /etc/aibox-master
  \$SUDO install -m 600 -o root -g root \"$REMOTE_TMP\" /etc/aibox-master/cloudflare.env
  rm -f \"$REMOTE_TMP\"
  echo ''
  echo '  ✓ Récap fichier :'
  \$SUDO ls -la /etc/aibox-master/cloudflare.env
  echo '  ✓ Hash SHA256 :'
  \$SUDO sha256sum /etc/aibox-master/cloudflare.env
"

c_green "✓ Provisioning terminé"
c_green ""
c_green "Étapes suivantes :"
c_green "  1. Si le wizard tourne déjà : restart pour qu'il re-lise env_file"
c_green "     ssh $SSH_TARGET 'docker restart aibox-setup-api'"
c_green "  2. Vérifier côté wizard : la section credentials Cloudflare doit"
c_green "     être masquée et le client ne doit voir QUE le champ sous-domaine."
