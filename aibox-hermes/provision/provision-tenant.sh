#!/usr/bin/env bash
# =============================================================================
# AI Box — provisionne UN Hermes (variante single-instance, POC). IDEMPOTENT.
# NB : le modèle produit est multi-user (1 Hermes/employé) — voir
#      wizard-company.sh + wizard-user.sh. Ce script reste utile pour un POC mono-user.
# Codifie aibox-hermes/QUICKSTART-POC.md en une commande.
#
# Usage :
#   provision-tenant.sh <slug> [--check]
#       --check  : dry-run, n'exécute rien, affiche ce qui serait fait.
#
# Env (sinon valeurs par défaut) :
#   AIBOX_TENANTS_ROOT       racine des tenants (def: /opt/aibox/tenants)
#   OLLAMA_BASE_URL          def: http://127.0.0.1:11434/v1
#   OLLAMA_MODEL             def: qwen3:14b
#   PENNYLANE_TOOL_BASE_URL  def: http://127.0.0.1:8081
#   PENNYLANE_TOOL_API_KEY   secret du microservice Pennylane
#   ANTHROPIC_API_KEY        optionnel — active le fallback cloud + le scrub RGPD
#   TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS   optionnel — canal employés
# =============================================================================
set -euo pipefail

CHECK=0
SLUG=""
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    -*) echo "option inconnue: $a" >&2; exit 2 ;;
    *) SLUG="$a" ;;
  esac
done
[ -z "$SLUG" ] && { echo "Usage: provision-tenant.sh <slug> [--check]"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # .../aibox-hermes
TENANTS_ROOT="${AIBOX_TENANTS_ROOT:-/opt/aibox/tenants}"
HERMES_HOME="$TENANTS_ROOT/$SLUG/hermes"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:14b}"
PENNYLANE_TOOL_BASE_URL="${PENNYLANE_TOOL_BASE_URL:-http://127.0.0.1:8081}"

say() { printf '  %s\n' "$*"; }
run() { if [ "$CHECK" = 1 ]; then echo "    [check] $*"; else eval "$@"; fi; }

echo "== Provisioning tenant '$SLUG' (check=$CHECK) =="
say "HERMES_HOME  = $HERMES_HOME"
say "aibox-hermes = $AIBOX_HERMES_DIR"

# 1. Arborescence tenant
run "mkdir -p '$HERMES_HOME/plugins'"

# 2. Plugins sécurité (symlink lecture seule depuis le repo)
for p in aibox-approval aibox-rgpd aibox-audit; do
  run "ln -sfn '$AIBOX_HERMES_DIR/plugins/$p' '$HERMES_HOME/plugins/$p'"
  say "plugin -> $p"
done

# 3. venv de chaque connecteur MCP
for conn in "$AIBOX_HERMES_DIR"/mcp-connectors/*/; do
  [ -f "${conn}requirements.txt" ] || continue
  name="$(basename "$conn")"
  run "python3 -m venv '${conn}.venv'"
  run "'${conn}.venv/bin/pip' install -q -r '${conn}requirements.txt'"
  say "connecteur MCP -> $name (venv)"
done

# 4. config.yaml rendu depuis le template
TPL="$AIBOX_HERMES_DIR/config/config.template.yaml"
OUT="$HERMES_HOME/config.yaml"
if [ "$CHECK" = 1 ]; then
  echo "    [check] render $TPL -> $OUT (substitue TENANT_DIR, Ollama, modèle)"
else
  sed -e "s#\${TENANT_DIR}#$AIBOX_HERMES_DIR#g" \
      -e "s#\${PENNYLANE_TOOL_BASE_URL}#$PENNYLANE_TOOL_BASE_URL#g" \
      -e "s#http://127.0.0.1:11434/v1#$OLLAMA_BASE_URL#g" \
      -e "s#default: \"qwen3:14b\"#default: \"$OLLAMA_MODEL\"#g" \
      "$TPL" > "$OUT"
fi
say "config -> $OUT"

# 5. .env (secrets ; généré si absent, JAMAIS écrasé)
ENV_FILE="$HERMES_HOME/.env"
if [ "$CHECK" = 1 ]; then
  echo "    [check] write $ENV_FILE (si absent)"
elif [ ! -f "$ENV_FILE" ]; then
  {
    echo "PENNYLANE_TOOL_API_KEY=${PENNYLANE_TOOL_API_KEY:-CHANGEME}"
    echo "AIBOX_MUTATING_TOOLS_REGEX=.*_create.*|.*create_.*|.*_update.*|.*_delete.*|.*_send.*|.*_pay.*|.*_refund.*|.*_cancel.*"
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
      echo "AIBOX_RGPD_SCRUB=${AIBOX_RGPD_SCRUB:-1}"     # cloud actif -> scrub ON
    else
      echo "AIBOX_RGPD_SCRUB=${AIBOX_RGPD_SCRUB:-0}"     # local-first -> scrub OFF
    fi
    [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
    [ -n "${TELEGRAM_ALLOWED_USERS:-}" ] && echo "TELEGRAM_ALLOWED_USERS=$TELEGRAM_ALLOWED_USERS"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  say "(.env déjà présent — préservé)"
fi
say ".env -> $ENV_FILE"

# 6. Fallback cloud (si clé + binaire hermes présents)
if [ -n "${ANTHROPIC_API_KEY:-}" ] && command -v hermes >/dev/null 2>&1; then
  run "HERMES_HOME='$HERMES_HOME' hermes fallback add anthropic claude-haiku-4-5 --priority 1 || true"
  say "fallback cloud -> Claude Haiku (priority 1), local en repli"
fi

echo "== OK. Lancer :  HERMES_HOME='$HERMES_HOME' hermes =="
