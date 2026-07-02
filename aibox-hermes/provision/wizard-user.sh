#!/usr/bin/env bash
# =============================================================================
# Wizard EMPLOYÉ — AI Box. Crée le Hermes PROPRE à un utilisateur, qui HÉRITE
# de la config entreprise (company.env). Chaque user = son Hermes (HERMES_HOME
# dédié) → isolation process, mémoire/credentials/RBAC propres. IDEMPOTENT.
#
# Usage : wizard-user.sh <company-slug> <user-slug> [--check]
# Env (sinon défauts) :
#   USER_NAME, USER_ROLE
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS   # canal de CE user
#   USER_CONNECTORS (csv ou 'all')               # RBAC : connecteurs autorisés
#   PENNYLANE_TOOL_API_KEY                        # clé perso si ≠ entreprise
# =============================================================================
set -euo pipefail

CHECK=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    -*) echo "option inconnue: $a" >&2; exit 2 ;;
    *) ARGS+=("$a") ;;
  esac
done
COMPANY="${ARGS[0]:-}"
USER_SLUG="${ARGS[1]:-}"
if [ -z "$COMPANY" ] || [ -z "$USER_SLUG" ]; then
  echo "Usage: wizard-user.sh <company-slug> <user-slug> [--check]"; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"
COMP_DIR="$AIBOX_ROOT/companies/$COMPANY"
CENV="$COMP_DIR/company.env"

# HÉRITAGE : on reprend les infos de l'entreprise (modèle, connecteurs, clés…)
if [ -f "$CENV" ]; then
  # shellcheck disable=SC1090
  . "$CENV"
elif [ "$CHECK" != 1 ]; then
  echo "Entreprise non provisionnée. Lance d'abord : wizard-company.sh $COMPANY"; exit 1
fi

USER_NAME="${USER_NAME:-$USER_SLUG}"
USER_ROLE="${USER_ROLE:-employé}"
USER_CONNECTORS="${USER_CONNECTORS:-${ENABLED_CONNECTORS:-pennylane}}"
HERMES_HOME="$COMP_DIR/users/$USER_SLUG/hermes"

say() { printf '  %s\n' "$*"; }
run() { if [ "$CHECK" = 1 ]; then echo "    [check] $*"; else eval "$@"; fi; }

echo "== Wizard employé '$USER_NAME' ($USER_SLUG) @ ${COMPANY_NAME:-$COMPANY} (check=$CHECK) =="
say "hérite : modèle ${OLLAMA_MODEL:-?} | connecteurs ${ENABLED_CONNECTORS:-?} | cloud $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo oui || echo non)"
say "RBAC connecteurs de ce user : $USER_CONNECTORS"
say "HERMES_HOME = $HERMES_HOME"

run "mkdir -p '$HERMES_HOME/plugins'"
# aibox-chat = plugin dashboard (onglet « Assistant » → chat épuré) ; les 3 autres
# = plugins agent (hooks approval/rgpd/audit). Tous symlinkés depuis le repo.
for p in aibox-approval aibox-rgpd aibox-audit aibox-chat aibox-docs aibox-brand aibox-rights; do
  run "ln -sfn '$AIBOX_HERMES_DIR/plugins/$p' '$HERMES_HOME/plugins/$p'"
done
say "plugins liés (sécurité + Assistant/Documentation + white-label + gestion droits)"

# RBAC : connecteurs actifs = intersection(entreprise, droits user)
ENABLED_N="${ENABLED_CONNECTORS//,/ }"
USERC_N="${USER_CONNECTORS//,/ }"
if [ "$USERC_N" = "all" ]; then
  ALLOWED_LIST="$ENABLED_N"
else
  ALLOWED_LIST=""
  for c in $ENABLED_N; do
    case " $USERC_N " in *" $c "*) ALLOWED_LIST="$ALLOWED_LIST $c" ;; esac
  done
fi
ALLOWED_CSV="$(echo "$ALLOWED_LIST" | tr -s ' ' | sed 's/^ //; s/ $//; s/ /,/g')"
say "RBAC -> connecteurs actifs : ${ALLOWED_CSV:-aucun}"

# config.yaml : généré avec RBAC (SEULS les connecteurs autorisés y figurent)
OUT="$HERMES_HOME/config.yaml"
run "python3 '$AIBOX_HERMES_DIR/provision/render_config.py' \
  --model '${OLLAMA_MODEL:-qwen3:8b}' \
  --base-url '${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}' \
  --connectors '$ALLOWED_CSV' \
  --tenant-dir '$AIBOX_HERMES_DIR' \
  --pennylane-base-url '${PENNYLANE_TOOL_BASE_URL:-http://127.0.0.1:8081}' > '$OUT'"
say "config -> $OUT"

# .env user : secrets entreprise hérités + spécifiques user
ENV_FILE="$HERMES_HOME/.env"
if [ "$CHECK" = 1 ]; then
  echo "    [check] write $ENV_FILE (hérite company + Telegram/RBAC du user)"
elif [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    [ -n "${PENNYLANE_TOOL_API_KEY:-}" ] && echo "PENNYLANE_TOOL_API_KEY='$PENNYLANE_TOOL_API_KEY'"
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY='$ANTHROPIC_API_KEY'"
    echo "AIBOX_RGPD_SCRUB='${AIBOX_RGPD_SCRUB:-0}'"
    echo "AIBOX_MUTATING_TOOLS_REGEX='${AIBOX_MUTATING_TOOLS_REGEX:-.*_create.*|.*_update.*|.*_delete.*|.*_send.*}'"
    echo "AIBOX_USER_CONNECTORS='$USER_CONNECTORS'"   # RBAC (enforcement connecteur : à finaliser)
    [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "TELEGRAM_BOT_TOKEN='$TELEGRAM_BOT_TOKEN'"
    [ -n "${TELEGRAM_ALLOWED_USERS:-}" ] && echo "TELEGRAM_ALLOWED_USERS='$TELEGRAM_ALLOWED_USERS'"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  say "(.env déjà présent — préservé)"
fi
say ".env -> $ENV_FILE"

# SOUL.md : personnalité/branding propre au user. Écrit UNE FOIS puis préservé —
# un re-run du wizard (idempotence) ne doit pas écraser une personnalité éditée à la main.
if [ "$CHECK" != 1 ] && [ ! -f "$HERMES_HOME/SOUL.md" ]; then
  cat > "$HERMES_HOME/SOUL.md" <<EOF
# ${COMPANY_NAME:-$COMPANY} — Assistant IA

Tu es l'assistant IA personnel de **$USER_NAME** ($USER_ROLE), chez ${COMPANY_NAME:-$COMPANY}.
Réponds en français, de façon professionnelle, concise et utile.
N'utilise que les outils métier autorisés pour cet utilisateur.
Toute action sensible (envoi de mail, création/suppression…) demande une validation.
EOF
fi
say "SOUL -> $HERMES_HOME/SOUL.md"

# Activer les plugins sécurité (Hermes les détecte mais ne les charge PAS par défaut)
if command -v hermes >/dev/null 2>&1; then
  for p in aibox-approval aibox-rgpd aibox-audit; do
    run "HERMES_HOME='$HERMES_HOME' hermes plugins enable $p >/dev/null 2>&1 || true"
  done
  say "plugins activés : approval, rgpd, audit"
fi

# Thème dashboard "AI Box" (update-safe : vit dans HERMES_HOME/dashboard-themes/)
THEME_SRC="$AIBOX_HERMES_DIR/branding/dashboard-themes/aibox.yaml"
if [ -f "$THEME_SRC" ]; then
  run "mkdir -p '$HERMES_HOME/dashboard-themes'"
  run "ln -sfn '$THEME_SRC' '$HERMES_HOME/dashboard-themes/aibox.yaml'"
  command -v hermes >/dev/null 2>&1 && run "HERMES_HOME='$HERMES_HOME' hermes config set theme aibox >/dev/null 2>&1 || true"
  say "thème dashboard AI Box appliqué"
fi

# Fallback cloud (si clé héritée + binaire hermes présents)
if [ -n "${ANTHROPIC_API_KEY:-}" ] && command -v hermes >/dev/null 2>&1; then
  run "HERMES_HOME='$HERMES_HOME' hermes fallback add anthropic claude-haiku-4-5 --priority 1 || true"
  say "fallback cloud Haiku (priority 1), local en repli"
fi

echo "== OK. Lancer le Hermes de $USER_SLUG :  HERMES_HOME='$HERMES_HOME' hermes =="
