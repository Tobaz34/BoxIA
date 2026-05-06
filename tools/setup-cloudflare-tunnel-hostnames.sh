#!/usr/bin/env bash
# =============================================================================
# setup-cloudflare-tunnel-hostnames.sh
# -----------------------------------------------------------------------------
# Configure les sous-domaines d'accès distant pour une box AI Box, via
# l'API Cloudflare Tunnel.
#
# Pour chaque service exposé (n8n, dify, etc.), le script :
#   1. Ajoute un "ingress rule" dans la config du tunnel cloudflared
#      (mapping <sub>.<DOMAIN> → http://localhost:<port> côté box)
#   2. Crée un DNS CNAME `<sub>.<DOMAIN>` → `<tunnel-id>.cfargotunnel.com`
#
# Idempotent : on peut le rejouer sans rien casser (UPSERT côté API CF).
#
# Usage :
#   tools/setup-cloudflare-tunnel-hostnames.sh
#       [--dry-run]                    # affiche les actions sans rien modifier
#       [--remove]                     # retire les hostnames au lieu de les ajouter
#       [--services flows,agents]      # restreint à un sous-ensemble (default: all)
#
# Variables d'env requises (à mettre dans /srv/ai-stack/.env) :
#   CF_API_TOKEN          API token Cloudflare avec scopes
#                         `Cloudflare Tunnel:Edit` + `Zone:DNS:Edit`
#                         (à créer sur dash.cloudflare.com → Profile → API Tokens)
#   CF_ACCOUNT_ID         ID du compte Cloudflare (visible en bas droite du
#                         dashboard Cloudflare, ou via l'API)
#   CF_TUNNEL_ID          ID du tunnel cloudflared déjà créé
#                         (visible sur one.dash.cloudflare.com → Networks →
#                          Tunnels → ton tunnel → onglet "Configure")
#   CF_ZONE_ID            ID de la zone DNS (ex: zone `ialocal.pro`)
#                         (visible sur dash.cloudflare.com → ta zone → Overview)
#   AIBOX_PUBLIC_DOMAIN   Domaine racine de la box (ex: demo.ialocal.pro)
#                         /!\ DOIT être un sous-domaine de la zone CF_ZONE_ID
#
# Exemple de setup pour un nouveau client :
#   1. Le client crée un tunnel sur dash.cloudflare.com (ou via cloudflared CLI)
#   2. Récupère les 4 IDs ci-dessus depuis le dashboard
#   3. Les ajoute dans /srv/ai-stack/.env
#   4. Lance ce script : `tools/setup-cloudflare-tunnel-hostnames.sh`
#   5. cloudflared restart automatique côté box (lit la config depuis l'API
#      à chaque connexion, pas besoin de redémarrer le daemon)
#
# Pré-requis : curl, jq, awk
# =============================================================================
set -euo pipefail

SERVICES_DEFAULT="flows agents auth admin metrics"
DRY_RUN=0
REMOVE=0
SERVICES_FILTER=""
ENV_FILE="${ENV_FILE:-/srv/ai-stack/.env}"
# Si exécuté depuis le repo dev (pas sur la box), permettre un .env local
if [[ ! -f "$ENV_FILE" && -f ".env" ]]; then ENV_FILE=".env"; fi

# ---- Mapping service -> port interne (où cloudflared route le trafic) ------
# Doit rester aligné avec services/edge/Caddyfile et services/app/src/app/api/sso/[service]/route.ts.
declare -A SERVICE_PORT=(
    ["flows"]=5678          # n8n
    ["agents"]=8081         # Dify (nginx → web/api)
    ["auth"]=9000           # Authentik
    ["admin"]=9443          # Portainer (HTTPS interne, no_tls_verify côté CF)
    ["metrics"]=3001        # Grafana
)
declare -A SERVICE_PROTO=(
    ["flows"]="http"
    ["agents"]="http"
    ["auth"]="http"
    ["admin"]="https"       # Portainer Edge
    ["metrics"]="http"
)

# ---- Couleurs --------------------------------------------------------------
if [[ -t 1 ]]; then
    C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_BLUE='\033[1;36m'
    C_YELLOW='\033[1;33m'; C_RESET='\033[0m'
else
    C_RED=''; C_GREEN=''; C_BLUE=''; C_YELLOW=''; C_RESET=''
fi
info()  { echo -e "${C_BLUE}▶${C_RESET} $*"; }
ok()    { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}⚠${C_RESET} $*" >&2; }
err()   { echo -e "${C_RED}✗${C_RESET} $*" >&2; }

# ---- Args ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift;;
        --remove)  REMOVE=1; shift;;
        --services) SERVICES_FILTER="$2"; shift 2;;
        -h|--help)
            sed -n '1,40p' "$0" | grep -E '^#' | sed 's/^# \?//'
            exit 0;;
        *) err "Argument inconnu : $1"; exit 1;;
    esac
done

# ---- Pré-requis ------------------------------------------------------------
for cmd in curl jq awk; do
    command -v "$cmd" >/dev/null || { err "$cmd introuvable"; exit 1; }
done

# ---- Charge .env si présent (et que les vars ne sont pas déjà set) --------
if [[ -f "$ENV_FILE" ]]; then
    info "Charge env depuis $ENV_FILE"
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
fi

# ---- Alias CLOUDFLARE_* → CF_* (le wizard écrit avec préfixe CLOUDFLARE_,
# le script utilise CF_ historiquement). Si la var CF_X n'est pas set mais
# CLOUDFLARE_X l'est, on la mappe.
[[ -z "${CF_API_TOKEN:-}"  && -n "${CLOUDFLARE_API_TOKEN:-}"  ]] && CF_API_TOKEN="$CLOUDFLARE_API_TOKEN"
[[ -z "${CF_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && CF_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
[[ -z "${CF_TUNNEL_ID:-}"  && -n "${CLOUDFLARE_TUNNEL_ID:-}"  ]] && CF_TUNNEL_ID="$CLOUDFLARE_TUNNEL_ID"
[[ -z "${CF_ZONE_ID:-}"    && -n "${CLOUDFLARE_ZONE_ID:-}"    ]] && CF_ZONE_ID="$CLOUDFLARE_ZONE_ID"

# ---- Vérifie env vars ------------------------------------------------------
missing=()
for v in CF_API_TOKEN CF_ACCOUNT_ID CF_TUNNEL_ID CF_ZONE_ID AIBOX_PUBLIC_DOMAIN; do
    [[ -z "${!v:-}" ]] && missing+=("$v")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    err "Variables d'env manquantes : ${missing[*]}"
    err "Voir l'en-tête de ce script pour leur signification."
    err "(Note : le script accepte aussi CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,"
    err " CLOUDFLARE_TUNNEL_ID, CLOUDFLARE_ZONE_ID en alias.)"
    exit 1
fi
ok "Env OK ($AIBOX_PUBLIC_DOMAIN, tunnel ${CF_TUNNEL_ID:0:8}…)"

# Filtre services
if [[ -n "$SERVICES_FILTER" ]]; then
    SERVICES_LIST="${SERVICES_FILTER//,/ }"
else
    SERVICES_LIST="$SERVICES_DEFAULT"
fi

# ---- Helpers API Cloudflare -----------------------------------------------
CF_API="https://api.cloudflare.com/client/v4"

cf_call() {
    # cf_call <method> <path> [body]
    local method="$1" path="$2" body="${3:-}"
    if [[ -n "$body" ]]; then
        curl -sS -X "$method" "$CF_API$path" \
            -H "Authorization: Bearer $CF_API_TOKEN" \
            -H "Content-Type: application/json" \
            --data "$body"
    else
        curl -sS -X "$method" "$CF_API$path" \
            -H "Authorization: Bearer $CF_API_TOKEN"
    fi
}

cf_check_success() {
    # Lit le JSON depuis stdin, vérifie {success: true}, échoue sinon.
    local label="$1"
    local resp
    resp=$(cat)
    if [[ "$(echo "$resp" | jq -r '.success // false')" != "true" ]]; then
        err "$label : échec API CF"
        echo "$resp" | jq -r '.errors // [] | .[] | "  - " + (.code|tostring) + ": " + .message' >&2
        return 1
    fi
    echo "$resp"
}

# ---- 1. Récupère config tunnel actuelle -----------------------------------
info "Lecture config tunnel actuelle"
TUNNEL_CFG=$(cf_call GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" | cf_check_success "GET tunnel config")
CURRENT_INGRESS=$(echo "$TUNNEL_CFG" | jq '.result.config.ingress // []')
CURRENT_INGRESS_LEN=$(echo "$CURRENT_INGRESS" | jq 'length')
ok "Ingress actuel : $CURRENT_INGRESS_LEN règle(s)"

TUNNEL_CNAME_TARGET="${CF_TUNNEL_ID}.cfargotunnel.com"

# ---- 2. Construit le nouveau ingress --------------------------------------
# Stratégie : on retire toutes les règles actuelles qui matchent un de NOS
# hostnames (`<sub>.<AIBOX_PUBLIC_DOMAIN>` ou `<AIBOX_PUBLIC_DOMAIN>` lui-même),
# on ajoute les nouvelles, on préserve les autres + la règle catch-all 404.
NEW_INGRESS=$(echo "$CURRENT_INGRESS" | jq --arg domain "$AIBOX_PUBLIC_DOMAIN" '
    map(select(
        (.hostname // "") != $domain
        and (.hostname // "") | endswith("." + $domain) | not
    ))
')

# Toujours garder le catch-all en fin de liste (404). Si pas présent dans
# l'existant, on l'ajoute. Sinon on le sort temporairement.
HAS_CATCHALL=$(echo "$NEW_INGRESS" | jq 'map(select(.service != null and (.hostname // "") == "")) | length')
NEW_INGRESS=$(echo "$NEW_INGRESS" | jq 'map(select(.hostname != null and .hostname != ""))')

# Ajoute la racine `<AIBOX_PUBLIC_DOMAIN>` → aibox-app port 3100
if [[ "$REMOVE" -eq 0 ]]; then
    NEW_INGRESS=$(echo "$NEW_INGRESS" | jq --arg host "$AIBOX_PUBLIC_DOMAIN" \
        '. + [{hostname: $host, service: "http://localhost:3100"}]')
fi

# Ajoute / retire chaque service
for sub in $SERVICES_LIST; do
    port="${SERVICE_PORT[$sub]:-}"
    proto="${SERVICE_PROTO[$sub]:-http}"
    if [[ -z "$port" ]]; then
        warn "Service inconnu '$sub' — ignoré"
        continue
    fi
    fqdn="${sub}.${AIBOX_PUBLIC_DOMAIN}"
    if [[ "$REMOVE" -eq 1 ]]; then
        info "[remove] $fqdn"
        # Déjà retiré par le filter ci-dessus
    else
        target="${proto}://localhost:${port}"
        # Pour HTTPS interne (Portainer), désactive la vérif TLS
        if [[ "$proto" == "https" ]]; then
            entry=$(jq -n --arg host "$fqdn" --arg svc "$target" \
                '{hostname: $host, service: $svc, originRequest: {noTLSVerify: true}}')
        else
            entry=$(jq -n --arg host "$fqdn" --arg svc "$target" \
                '{hostname: $host, service: $svc}')
        fi
        NEW_INGRESS=$(echo "$NEW_INGRESS" | jq --argjson entry "$entry" '. + [$entry]')
        info "[add]    $fqdn → $target"
    fi
done

# Append catch-all 404 final (n8n et CF refusent une config sans catch-all)
NEW_INGRESS=$(echo "$NEW_INGRESS" | jq '. + [{service: "http_status:404"}]')

# ---- 3. PUT la nouvelle config --------------------------------------------
PAYLOAD=$(jq -n --argjson ingress "$NEW_INGRESS" \
    '{config: {ingress: $ingress}}')

if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] Nouvelle config tunnel qui SERAIT poussée :"
    echo "$PAYLOAD" | jq .
else
    info "PUT config tunnel"
    cf_call PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" "$PAYLOAD" \
        | cf_check_success "PUT tunnel config" >/dev/null
    ok "Config tunnel mise à jour"
fi

# ---- 4. DNS CNAMEs --------------------------------------------------------
manage_dns_record() {
    local fqdn="$1"
    # Cherche un record existant
    local existing
    existing=$(cf_call GET "/zones/$CF_ZONE_ID/dns_records?name=$fqdn&type=CNAME" \
        | jq -r '.result[0].id // empty')

    if [[ "$REMOVE" -eq 1 ]]; then
        if [[ -n "$existing" ]]; then
            if [[ "$DRY_RUN" -eq 1 ]]; then
                info "[dry-run] DELETE DNS $fqdn (id $existing)"
            else
                cf_call DELETE "/zones/$CF_ZONE_ID/dns_records/$existing" \
                    | cf_check_success "DELETE DNS $fqdn" >/dev/null
                ok "DNS supprimé : $fqdn"
            fi
        fi
        return
    fi

    local body
    body=$(jq -n --arg name "$fqdn" --arg target "$TUNNEL_CNAME_TARGET" \
        '{type: "CNAME", name: $name, content: $target, proxied: true, ttl: 1}')

    if [[ -n "$existing" ]]; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
            info "[dry-run] PATCH DNS $fqdn (id $existing) → $TUNNEL_CNAME_TARGET"
        else
            cf_call PATCH "/zones/$CF_ZONE_ID/dns_records/$existing" "$body" \
                | cf_check_success "PATCH DNS $fqdn" >/dev/null
            ok "DNS mis à jour : $fqdn"
        fi
    else
        if [[ "$DRY_RUN" -eq 1 ]]; then
            info "[dry-run] POST DNS $fqdn → $TUNNEL_CNAME_TARGET (proxied)"
        else
            cf_call POST "/zones/$CF_ZONE_ID/dns_records" "$body" \
                | cf_check_success "POST DNS $fqdn" >/dev/null
            ok "DNS créé : $fqdn"
        fi
    fi
}

# Racine (uniquement si pas en remove — on ne casse pas l'accès principal)
if [[ "$REMOVE" -eq 0 ]]; then
    manage_dns_record "$AIBOX_PUBLIC_DOMAIN"
fi
for sub in $SERVICES_LIST; do
    [[ -z "${SERVICE_PORT[$sub]:-}" ]] && continue
    manage_dns_record "${sub}.${AIBOX_PUBLIC_DOMAIN}"
done

# ---- Récap ----------------------------------------------------------------
echo
ok "Setup Cloudflare Tunnel terminé."
if [[ "$REMOVE" -eq 0 ]]; then
    echo
    echo "Hostnames actifs :"
    echo "  - https://$AIBOX_PUBLIC_DOMAIN  (aibox-app)"
    for sub in $SERVICES_LIST; do
        [[ -z "${SERVICE_PORT[$sub]:-}" ]] && continue
        echo "  - https://${sub}.${AIBOX_PUBLIC_DOMAIN}  (port ${SERVICE_PORT[$sub]})"
    done
    echo
    echo "Pour activer côté aibox-app, ajoute dans $ENV_FILE :"
    echo "  AIBOX_PUBLIC_DOMAIN=$AIBOX_PUBLIC_DOMAIN"
    echo "Puis redémarre aibox-app : docker compose -f services/app/docker-compose.yml up -d"
fi
