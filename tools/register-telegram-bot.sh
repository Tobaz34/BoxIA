#!/usr/bin/env bash
# =============================================================================
# register-telegram-bot.sh
# -----------------------------------------------------------------------------
# Enregistre un bot Telegram pour un tenant Hermes existant (ou pour
# l'instance Hermes principale par défaut).
#
# Pré-requis : le bot a déjà été créé via @BotFather dans Telegram (le script
# ne peut pas le faire, c'est une action interactive Telegram).
#
# Usage :
#   tools/register-telegram-bot.sh <TELEGRAM_BOT_TOKEN> [TENANT_ID]
#
#   TELEGRAM_BOT_TOKEN : du format 123456789:ABCdef...
#   TENANT_ID          : (optionnel) slug du tenant. Par défaut = instance
#                        principale (/srv/xefia/hermes/).
#
# Le script :
#   1. Valide le token Telegram via getMe API
#   2. Récupère les chat_id récents via getUpdates (te dit qui a parlé au bot)
#   3. Te demande quels chat_id whitelist
#   4. Écrit TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS dans le .env du tenant
#   5. Restart le container Hermes pour appliquer
#   6. Test : envoie un message via Telegram API au premier chat_id whitelisté
# =============================================================================
set -euo pipefail

if [ $# -lt 1 ]; then
  sed -n '2,25p' "$0"
  exit 2
fi

TELEGRAM_BOT_TOKEN="$1"
TENANT_ID="${2:-}"

SSH_HOST="${HERMES_SSH_HOST:-clikinfo@192.168.15.210}"

if [ -n "$TENANT_ID" ]; then
  TENANT_DIR="/srv/xefia/hermes_${TENANT_ID}/compose"
  CONTAINER="hermes-${TENANT_ID}"
else
  TENANT_DIR="/srv/xefia/hermes"
  CONTAINER="hermes"
fi

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. Validation token ---------------------------------------------------
log "[1/6] Validation token via Telegram getMe"
BOT_INFO=$(curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe") || \
  fail "Token Telegram invalide (getMe failed)"
BOT_USERNAME=$(echo "$BOT_INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['username'])")
BOT_FIRST_NAME=$(echo "$BOT_INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'].get('first_name',''))")
ok "Bot valide : @$BOT_USERNAME ($BOT_FIRST_NAME)"

# ---- 2. Récup chat_id récents -----------------------------------------------
log "[2/6] Recherche chat_id qui ont récemment parlé au bot"
UPDATES=$(curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates")
CHAT_IDS=$(echo "$UPDATES" | python3 -c "
import json, sys
data = json.load(sys.stdin)
seen = set()
out = []
for upd in data.get('result', []):
    msg = upd.get('message') or upd.get('edited_message') or {}
    chat = msg.get('chat') or {}
    cid = chat.get('id')
    if cid and cid not in seen:
        seen.add(cid)
        name = chat.get('first_name') or chat.get('title') or chat.get('username') or 'inconnu'
        out.append(f'{cid}\t{name}')
print('\n'.join(out))
")

if [ -z "$CHAT_IDS" ]; then
  echo ""
  echo "⚠ Aucun message récent. Pour récupérer ton chat_id :"
  echo "   1. Ouvre Telegram"
  echo "   2. Cherche @$BOT_USERNAME"
  echo "   3. Envoie /start au bot"
  echo "   4. Relance ce script"
  exit 1
fi

echo ""
echo "Chat IDs trouvés :"
echo "$CHAT_IDS" | nl -w2 -s'. '
echo ""

# ---- 3. Choix des chat_id à whitelist ---------------------------------------
log "[3/6] Sélection des users autorisés"
if [ -t 0 ]; then
  read -r -p "Quels chat_id whitelist (comma-sep, ex: 12345,67890) : " ALLOWED
else
  # Mode non-interactif : whitelist le premier chat_id par défaut
  ALLOWED=$(echo "$CHAT_IDS" | head -1 | cut -f1)
  echo "Mode non-interactif → whitelist auto : $ALLOWED"
fi
[ -z "$ALLOWED" ] && fail "Aucun chat_id whitelisté → abort"

# ---- 4. Update .env (ssh) --------------------------------------------------
log "[4/6] Update $TENANT_DIR/.env"
ssh -o BatchMode=yes "$SSH_HOST" "
  set -e
  ENV_FILE='$TENANT_DIR/.env'
  test -f \"\$ENV_FILE\" || { echo 'ENV file absent : '\"\$ENV_FILE\"; exit 1; }
  # Strip ancien token / users si déjà là
  grep -v -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USERS)=' \"\$ENV_FILE\" > \"\$ENV_FILE.tmp\"
  echo 'TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN' >> \"\$ENV_FILE.tmp\"
  echo 'TELEGRAM_ALLOWED_USERS=$ALLOWED' >> \"\$ENV_FILE.tmp\"
  mv \"\$ENV_FILE.tmp\" \"\$ENV_FILE\"
  chmod 600 \"\$ENV_FILE\"
"
ok ".env mis à jour"

# ---- 5. Restart container --------------------------------------------------
log "[5/6] Restart $CONTAINER pour appliquer"
ssh -o BatchMode=yes "$SSH_HOST" "docker compose -f '$TENANT_DIR/docker-compose.yml' restart"
sleep 20

HEALTH=$(ssh -o BatchMode=yes "$SSH_HOST" "docker inspect $CONTAINER --format '{{.State.Health.Status}}' 2>/dev/null" || echo unknown)
[ "$HEALTH" = "healthy" ] || fail "Container $CONTAINER pas healthy après restart : $HEALTH"
ok "$CONTAINER healthy"

# ---- 6. Test envoi Telegram ------------------------------------------------
log "[6/6] Test envoi message Telegram"
FIRST_CHAT=$(echo "$ALLOWED" | cut -d, -f1)
RESP=$(curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=$FIRST_CHAT" \
  -d "text=✓ Hermes Agent connecté. Envoie-moi un message pour démarrer.")
echo "$RESP" | head -c 200
echo ""
ok "Message test envoyé à $FIRST_CHAT"

echo ""
ok "==============================================="
ok "  Bot Telegram @$BOT_USERNAME enregistré"
ok "==============================================="
echo ""
echo "  Chat IDs whitelistés : $ALLOWED"
echo "  Container            : $CONTAINER (healthy)"
echo "  Pour test            : envoie un message au bot sur Telegram"
