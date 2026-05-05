#!/usr/bin/env bash
# =============================================================================
# configure-aibox-domain.sh
# -----------------------------------------------------------------------------
# Configure le domaine HTTPS public d'une box AI Box (pré-requis pour OIDC).
#
# Modifie /srv/ai-stack/.env :
#   - NEXTAUTH_URL → https://<subdomain>
#   - OAUTH_REDIRECT_BASE_URL → idem (au cas où on veut découpler plus tard)
# Imprime ensuite les étapes manuelles restantes :
#   - Création tunnel Cloudflare
#   - Provisionning DNS chez OVH (CNAME ou délégation NS)
#   - Configuration redirect URI chez Google Cloud / Microsoft Entra
#
# Usage : sur xefia, sous l'utilisateur clikinfo (qui possède .env) :
#   bash tools/configure-aibox-domain.sh demo.ialocal.pro
#
# Idempotent : peut être ré-exécuté pour changer le domaine. Backup .env
# créé avec timestamp.
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage : $0 <subdomain.example.com>" >&2
  echo "Ex.   : $0 demo.ialocal.pro" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  echo "Domaine invalide : $DOMAIN" >&2
  exit 1
fi

REPO="${AIBOX_SERVER_REPO:-/srv/ai-stack}"
ENV_FILE="$REPO/.env"
URL="https://$DOMAIN"
REDIRECT="$URL/api/oauth/callback"

if [[ ! -w "$ENV_FILE" ]]; then
  echo "Le fichier $ENV_FILE n'est pas modifiable par cet utilisateur ($(whoami))." >&2
  echo "Lance ce script sous clikinfo qui possède .env." >&2
  exit 1
fi

# Backup
backup="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup"
echo "Backup .env : $backup"

# Helper qui set ou remplace une variable dans .env (idempotent).
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # remplace en place
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "  $key mis à jour"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  $key ajouté"
  fi
}

echo "Mise à jour $ENV_FILE :"
set_env "NEXTAUTH_URL" "$URL"
set_env "OAUTH_REDIRECT_BASE_URL" "$URL"

cat <<EOF

=== Domaine configuré : $DOMAIN ===

Étapes restantes (manuelles, par ordre) :

1. Cloudflare Tunnel
   - cloudflared tunnel login                               (browser, te connecte à CF)
   - cloudflared tunnel create aibox-${DOMAIN%%.*}          (crée le tunnel)
   - cat ~/.cloudflared/*.json | grep TunnelID              (note l'ID)
   - sudo nano /etc/cloudflared/config.yml                  (cf bloc ci-dessous)
   - sudo systemctl enable --now cloudflared

   /etc/cloudflared/config.yml :
     tunnel: aibox-${DOMAIN%%.*}
     credentials-file: /home/clikinfo/.cloudflared/<TUNNEL_ID>.json
     ingress:
       - hostname: $DOMAIN
         service: http://localhost:3100
       - service: http_status:404

2. DNS chez OVH (2 sous-options)

   2.a (recommandé) Déléguer ialocal.pro à Cloudflare :
       Cloudflare dashboard → Add Site → ialocal.pro → Free
       OVH → Domaines → ialocal.pro → Serveurs DNS → coller les 2 NS Cloudflare
       Puis : cloudflared tunnel route dns aibox-${DOMAIN%%.*} $DOMAIN
       (crée le CNAME automatiquement)

   2.b Garder DNS chez OVH (manuel) :
       OVH → Domaines → ialocal.pro → Zone DNS → Ajouter une entrée
         Type : CNAME
         Sous-domaine : ${DOMAIN%%.*}
         Cible : <TUNNEL_ID>.cfargotunnel.com.

3. Google Cloud Console (https://console.cloud.google.com/apis/credentials)
   - Create credentials → OAuth client → Web application
   - Authorized redirect URIs : $REDIRECT
   - Coller le client_id et secret dans $ENV_FILE :
       GOOGLE_OAUTH_CLIENT_ID=...
       GOOGLE_OAUTH_CLIENT_SECRET=...

4. Microsoft Entra (https://entra.microsoft.com → App registrations)
   - New registration → Web → Redirect URI : $REDIRECT
   - API permissions → Microsoft Graph delegated (Files.Read, Mail.Read, etc.)
   - Certificates & secrets → New client secret
   - Coller dans $ENV_FILE :
       MICROSOFT_OAUTH_CLIENT_ID=...
       MICROSOFT_OAUTH_CLIENT_SECRET=...

5. Rebuild + redeploy aibox-app pour que .env soit re-chargé :
   tools/deploy-to-xefia.sh main

6. Test : ouvrir https://$DOMAIN/connectors → Documents → Google Drive
   → bouton "Connecter avec Google" doit ouvrir une popup vers
   accounts.google.com et revenir sur $REDIRECT

EOF
