#!/usr/bin/env bash
# aibox-host/wizard.sh — wizard interactif post-install
#
# Collecte les paramètres client final puis génère /opt/aibox/hermes/.env :
#   - Nom de l'entreprise
#   - Clé cloud LLM (Anthropic recommandé) ou local-only
#   - Bot Telegram (token + chat_ids autorisés)
#   - Connecteurs FR à activer (Pennylane, Odoo, GLPI, FEC, 3CX)
#
# Peut être relancé pour changer la conf (les valeurs existantes sont prompts par défaut).
set -euo pipefail

AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"
HERMES_DIR="$AIBOX_ROOT/hermes"
ENV_FILE="$HERMES_DIR/.env"

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ -t 0 ] || fail "wizard.sh exige un TTY interactif. Sur machine sans écran : SSH puis relance-le."

mkdir -p "$HERMES_DIR"

# Charge l'existant si présent
get_existing() {
  local key="$1"
  [ -f "$ENV_FILE" ] || { echo ""; return; }
  grep "^$key=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || echo ""
}

ask() {
  local var="$1" prompt="$2" default="$3" current
  current=$(get_existing "$var")
  default="${current:-$default}"
  local val
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default] : " val
    val="${val:-$default}"
  else
    read -r -p "  $prompt : " val
  fi
  printf -v "$var" '%s' "$val"
}

ask_secret() {
  local var="$1" prompt="$2" current val
  current=$(get_existing "$var")
  if [ -n "$current" ]; then
    read -r -p "  $prompt [garder existant] : " val
    val="${val:-$current}"
  else
    read -r -s -p "  $prompt : " val; echo
  fi
  printf -v "$var" '%s' "$val"
}

ask_yes_no() {
  local var="$1" prompt="$2" default="${3:-y}"
  local val
  read -r -p "  $prompt [$default] : " val
  val="${val:-$default}"
  case "$val" in y|Y|yes|YES|oui|O) printf -v "$var" '%s' "yes" ;; *) printf -v "$var" '%s' "no" ;; esac
}

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Wizard de configuration AI Box"
echo "════════════════════════════════════════════════════════════"
echo ""

# === 1. Identité ===
log "[1/4] Identité entreprise"
ask AIBOX_COMPANY_NAME      "Nom de l'entreprise (ex. Boulangerie Martin)" ""
ask AIBOX_COMPANY_SLUG      "Slug (a-z, tirets ; sert dans logs/backups)" "$(echo "$AIBOX_COMPANY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')"
ask AIBOX_TIMEZONE          "Timezone" "Europe/Paris"

# === 2. Provider LLM ===
echo ""
log "[2/4] LLM (intelligence de l'agent)"
echo "  Choisir un provider :"
echo "    1) anthropic   — Claude Haiku (rapide, ~10€/mois/client)  [RECOMMANDÉ]"
echo "    2) gemini      — Gemini Flash (le moins cher)"
echo "    3) openrouter  — proxy vers Claude/GPT/etc."
echo "    4) openai      — GPT-4o-mini"
echo "    5) local       — qwen3:14b local seulement (lent, 100% souverain)"
ask AIBOX_PROVIDER_CHOICE "Choix [1-5]" "1"
case "$AIBOX_PROVIDER_CHOICE" in
  1) CLOUD_PROVIDER=anthropic ;;
  2) CLOUD_PROVIDER=gemini ;;
  3) CLOUD_PROVIDER=openrouter ;;
  4) CLOUD_PROVIDER=openai ;;
  5) CLOUD_PROVIDER=local ;;
  *) fail "Choix invalide" ;;
esac

if [ "$CLOUD_PROVIDER" != "local" ]; then
  case "$CLOUD_PROVIDER" in
    anthropic)   ask_secret ANTHROPIC_API_KEY   "Clé API Anthropic (commence par sk-ant-)" ;;
    gemini)      ask_secret GOOGLE_API_KEY      "Clé Google AI Studio" ;;
    openrouter)  ask_secret OPENROUTER_API_KEY  "Clé OpenRouter (commence par sk-or-)" ;;
    openai)      ask_secret OPENAI_API_KEY      "Clé OpenAI (commence par sk-)" ;;
  esac
fi

# === 3. Telegram ===
echo ""
log "[3/4] Telegram (canal client principal)"
echo "  Si tu n'as pas encore créé le bot : "
echo "    1. Ouvre Telegram, parle à @BotFather"
echo "    2. /newbot → choisis un nom + username (terminant en bot)"
echo "    3. Note le token (format 123456:ABC...)"
echo ""
ask_yes_no AIBOX_HAS_TELEGRAM "Tu as un token Telegram à configurer maintenant ?" "y"
if [ "$AIBOX_HAS_TELEGRAM" = "yes" ]; then
  ask_secret TELEGRAM_BOT_TOKEN  "Token bot Telegram"
  ask        TELEGRAM_ALLOWED_USERS "chat_id employés autorisés (comma-sep)" ""
  if [ -z "$TELEGRAM_ALLOWED_USERS" ]; then
    warn "Aucun chat_id — le bot répondra à personne tant que tu n'en ajoutes pas."
    warn "Pour obtenir un chat_id : envoie /start au bot puis curl https://api.telegram.org/bot\$TOKEN/getUpdates"
  fi
fi

# === 4. Connecteurs FR (TODO — squelette pour P3) ===
echo ""
log "[4/4] Connecteurs métier (optionnels, configurables plus tard)"
echo "  Les connecteurs activés seront accessibles à Hermes via API Bearer locale."
echo "  Tu pourras les activer/désactiver plus tard via : tools/aibox-host/connectors.sh"
ask_yes_no AIBOX_CFG_CONNECTORS "Configurer un ou plusieurs connecteurs maintenant ?" "n"
AIBOX_CONNECTORS=""
if [ "$AIBOX_CFG_CONNECTORS" = "yes" ]; then
  ask_yes_no _PEN "  Pennylane (compta)" "n";  [ "$_PEN" = "yes" ] && AIBOX_CONNECTORS="$AIBOX_CONNECTORS pennylane"
  ask_yes_no _ODO "  Odoo (ERP)"           "n";  [ "$_ODO" = "yes" ] && AIBOX_CONNECTORS="$AIBOX_CONNECTORS odoo"
  ask_yes_no _GLP "  GLPI (helpdesk)"      "n";  [ "$_GLP" = "yes" ] && AIBOX_CONNECTORS="$AIBOX_CONNECTORS glpi"
  ask_yes_no _FEC "  FEC import (compta)"  "n";  [ "$_FEC" = "yes" ] && AIBOX_CONNECTORS="$AIBOX_CONNECTORS fec"
  ask_yes_no _3CX "  3CX (téléphonie)"     "n";  [ "$_3CX" = "yes" ] && AIBOX_CONNECTORS="$AIBOX_CONNECTORS 3cx"
fi
AIBOX_CONNECTORS="$(echo "$AIBOX_CONNECTORS" | xargs)"

# === Génération .env ===
echo ""
log "Génération $ENV_FILE"

# API_SERVER_KEY : préserve si existante
API_SERVER_KEY=$(get_existing "API_SERVER_KEY")
[ -z "$API_SERVER_KEY" ] && API_SERVER_KEY=$(openssl rand -hex 24)

# AIBOX_AGENT_KEY : shared secret pour Hermes ↔ microservices connecteurs
AIBOX_AGENT_KEY=$(get_existing "AIBOX_AGENT_KEY")
[ -z "$AIBOX_AGENT_KEY" ] && AIBOX_AGENT_KEY=$(openssl rand -hex 32)

cat > "$ENV_FILE" <<EOF
# AI Box Hermes config — généré par wizard.sh ($(date -Iseconds))
AIBOX_COMPANY_NAME=$AIBOX_COMPANY_NAME
AIBOX_COMPANY_SLUG=$AIBOX_COMPANY_SLUG
TZ=$AIBOX_TIMEZONE

# Hermes API gateway (interne)
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=$API_SERVER_KEY
HERMES_DASHBOARD=1

# Bridge BoxIA (microservices connecteurs FR)
AIBOX_AGENT_KEY=$AIBOX_AGENT_KEY
AIBOX_CONNECTORS_ENABLED=$AIBOX_CONNECTORS
EOF

# Cloud LLM key
if [ "${CLOUD_PROVIDER:-}" != "local" ]; then
  case "$CLOUD_PROVIDER" in
    anthropic)   echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"   >> "$ENV_FILE" ;;
    gemini)      echo "GOOGLE_API_KEY=$GOOGLE_API_KEY"         >> "$ENV_FILE" ;;
    openrouter)  echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" >> "$ENV_FILE" ;;
    openai)      echo "OPENAI_API_KEY=$OPENAI_API_KEY"         >> "$ENV_FILE" ;;
  esac
fi
echo "AIBOX_PROVIDER=$CLOUD_PROVIDER" >> "$ENV_FILE"

# Telegram
if [ "${AIBOX_HAS_TELEGRAM:-no}" = "yes" ]; then
  {
    echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
    echo "TELEGRAM_ALLOWED_USERS=$TELEGRAM_ALLOWED_USERS"
  } >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"
ok ".env généré : $ENV_FILE"
echo ""
echo "Prochaine étape :"
echo "  - install.sh continue la suite (build + up + config Hermes + test)"
echo "  - Ou relance ce wizard si besoin de modifier : aibox-host/wizard.sh"
