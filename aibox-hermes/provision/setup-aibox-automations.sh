#!/usr/bin/env bash
# =============================================================================
# Rejoue (IDEMPOTENT) les automatisations AI Box d'un tenant "patron" (type andre)
# après un (re-)provisioning : scripts rapport/veille + crons Telegram + allowlist.
# Aligné sur l'esprit RÈGLE 2 (toute mutation runtime = script versionné rejouable).
#
# Usage :
#   HERMES_HOME=/home/clikinfo/aibox/companies/<co>/users/<patron>/hermes \
#   AIBOX_TELEGRAM_CHAT=<chat_id> \
#   bash provision/setup-aibox-automations.sh
#
# NE fait PAS : l'auth OAuth Codex (navigateur, manuelle) — voir note finale.
# =============================================================================
set -euo pipefail
HERMES_HOME="${HERMES_HOME:?HERMES_HOME requis}"
CHAT="${AIBOX_TELEGRAM_CHAT:-}"
HB="${HERMES_BIN:-/home/clikinfo/.local/bin/hermes}"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SRC="$HERE/../tenant-scripts"
say(){ echo "  $*"; }

# 1) scripts + state (réinstalle = resync avec le repo)
mkdir -p "$HERMES_HOME/scripts" "$HERMES_HOME/state"
install -m 755 "$SRC"/rapport-equipe.py "$SRC"/rapport-equipe.sh \
               "$SRC"/veilleur-urgence.py "$SRC"/veilleur-urgence.sh "$SRC"/detecteur-opportunites.py "$SRC"/detecteur-opportunites.sh "$HERMES_HOME/scripts/"
say "scripts installés -> $HERMES_HOME/scripts/"

# 2) allowlist Telegram (si chat fourni et absent)
if [ -n "$CHAT" ] && [ -f "$HERMES_HOME/.env" ] && ! grep -q '^TELEGRAM_ALLOWED_USERS=' "$HERMES_HOME/.env"; then
  printf '\n# allowlist Telegram (setup-aibox-automations)\nTELEGRAM_ALLOWED_USERS=%s\n' "$CHAT" >> "$HERMES_HOME/.env"
  say "allowlist Telegram ajoutée ($CHAT)"
fi

# 3) crons idempotents (par nom)
DELIV="local"; [ -n "$CHAT" ] && DELIV="telegram:$CHAT"
have_cron(){ HERMES_HOME="$HERMES_HOME" "$HB" cron list 2>/dev/null | grep -q "Name: *$1"; }

if have_cron "rapport-equipe"; then say "cron rapport-equipe déjà présent"; else
  HERMES_HOME="$HERMES_HOME" "$HB" cron create '0 9,12,15,18,21 * * 1-5' \
    --no-agent --script rapport-equipe.sh --deliver "$DELIV" --name rapport-equipe >/dev/null
  say "cron rapport-equipe créé ($DELIV)"
fi
if have_cron "veilleur-urgence"; then say "cron veilleur-urgence déjà présent"; else
  HERMES_HOME="$HERMES_HOME" "$HB" cron create '*/2 7-22 * * *' \
    --no-agent --script veilleur-urgence.sh --deliver "$DELIV" --name veilleur-urgence >/dev/null
  say "cron veilleur-urgence créé ($DELIV)"
fi
if have_cron "opportunites-commercial"; then say "cron opportunites-commercial deja present"; else
  HERMES_HOME="$HERMES_HOME" "$HB" cron create '0 9-18 * * 1-5' \n    --script detecteur-opportunites.sh --skill aibox-opportunite --deliver "$DELIV" --name opportunites-commercial >/dev/null
  say "cron opportunites-commercial cree ($DELIV) - agent commercial autonome (prepare, tu valides)"
fi
# revue-incidents : basculer sur Telegram si présent
if [ -n "$CHAT" ] && have_cron "revue-incidents"; then
  HERMES_HOME="$HERMES_HOME" "$HB" cron edit revue-incidents-odoo --deliver "telegram:$CHAT" >/dev/null 2>&1 || true
  say "revue-incidents -> deliver telegram"
fi

echo
echo "  ⚠️  Codex (ChatGPT/OpenAI) N'EST PAS rejoué (OAuth navigateur). Après reset :"
echo "        HERMES_HOME=$HERMES_HOME $HB auth add openai-codex --type oauth --no-browser"
echo "        puis re-sélectionner gpt-5.4 (dashboard) + fallback local qwen3."
echo "  ✅ Automatisations AI Box rejouées."
