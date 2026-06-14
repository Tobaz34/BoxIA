#!/usr/bin/env bash
# =============================================================================
# Wizard ENTREPRISE — AI Box. Configure les défauts PARTAGÉS d'une entreprise.
# Produit companies/<slug>/company.env (sourcé par chaque wizard-user) + une vue
# lisible company.yaml + les venvs MCP partagés. IDEMPOTENT.
#
# Modèle multi-user : 1 entreprise = config partagée ; 1 Hermes PAR employé
# (cf. wizard-user.sh). Ensuite : wizard-user.sh <slug> <user>.
#
# Usage : wizard-company.sh <slug> [--check]
# Env (sinon défauts/auto) :
#   COMPANY_NAME, AIBOX_ROOT (def /opt/aibox)
#   ANTHROPIC_API_KEY                 # optionnel : active cloud (Haiku) + RGPD scrub
#   OLLAMA_BASE_URL, OLLAMA_MODEL     # modèle local ; si vide → auto via cookbook
#   PREFER (quality|speed)            # pour l'auto-sélection cookbook
#   ENABLED_CONNECTORS (csv, def pennylane)
#   PENNYLANE_TOOL_BASE_URL, PENNYLANE_TOOL_API_KEY
#   AIBOX_RGPD_SCRUB
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
if [ -z "$SLUG" ]; then echo "Usage: wizard-company.sh <slug> [--check]"; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIBOX_HERMES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"
COMP_DIR="$AIBOX_ROOT/companies/$SLUG"
COMPANY_NAME="${COMPANY_NAME:-$SLUG}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
ENABLED_CONNECTORS="${ENABLED_CONNECTORS:-pennylane}"
PENNYLANE_TOOL_BASE_URL="${PENNYLANE_TOOL_BASE_URL:-http://127.0.0.1:8081}"
MUT_REGEX='.*_create.*|.*create_.*|.*_update.*|.*_delete.*|.*_send.*|.*_pay.*|.*_refund.*|.*_cancel.*'

say() { printf '  %s\n' "$*"; }
run() { if [ "$CHECK" = 1 ]; then echo "    [check] $*"; else eval "$@"; fi; }

echo "== Wizard entreprise '$COMPANY_NAME' ($SLUG) (check=$CHECK) =="

# Modèle local : auto via le Cookbook si non fourni (feature greffée d'Odysseus)
if [ -z "${OLLAMA_MODEL:-}" ]; then
  OLLAMA_MODEL=""
  if command -v python3 >/dev/null 2>&1; then
    OLLAMA_MODEL="$(python3 "$AIBOX_HERMES_DIR/cookbook/cookbook.py" --prefer "${PREFER:-quality}" --json 2>/dev/null \
      | sed -n 's/.*"recommended": *"\([^"]*\)".*/\1/p')"
  fi
  OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:8b}"
  say "modèle local auto (cookbook) -> $OLLAMA_MODEL"
fi

# Hermes exige >=64K de contexte → dériver un modèle 64K (num_ctx 65536) si le
# modèle de base est présent dans Ollama (qwen3 natif = 40K → refusé sinon).
if command -v ollama >/dev/null 2>&1 && ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$OLLAMA_MODEL"; then
  CTX_MODEL="${OLLAMA_MODEL%-64k}-64k"
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$CTX_MODEL"; then
    printf 'FROM %s\nPARAMETER num_ctx 65536\n' "$OLLAMA_MODEL" > "/tmp/aibox-mf.$$"
    run "ollama create '$CTX_MODEL' -f '/tmp/aibox-mf.$$'"
  fi
  OLLAMA_MODEL="$CTX_MODEL"
  say "modèle 64K dérivé -> $OLLAMA_MODEL"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then RGPD="${AIBOX_RGPD_SCRUB:-1}"; else RGPD="${AIBOX_RGPD_SCRUB:-0}"; fi

run "mkdir -p '$COMP_DIR/users'"

# Config partagée (secrets + défauts) — sourcée par wizard-user
if [ "$CHECK" = 1 ]; then
  echo "    [check] write $COMP_DIR/company.env (modèle=$OLLAMA_MODEL, connecteurs=$ENABLED_CONNECTORS, rgpd=$RGPD)"
else
  umask 077
  {
    echo "# AI Box — config partagée entreprise '$COMPANY_NAME'"
    echo "COMPANY_NAME='$COMPANY_NAME'"
    echo "OLLAMA_BASE_URL='$OLLAMA_BASE_URL'"
    echo "OLLAMA_MODEL='$OLLAMA_MODEL'"
    echo "ENABLED_CONNECTORS='$ENABLED_CONNECTORS'"
    echo "PENNYLANE_TOOL_BASE_URL='$PENNYLANE_TOOL_BASE_URL'"
    [ -n "${PENNYLANE_TOOL_API_KEY:-}" ] && echo "PENNYLANE_TOOL_API_KEY='$PENNYLANE_TOOL_API_KEY'"
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY='$ANTHROPIC_API_KEY'"
    echo "AIBOX_RGPD_SCRUB='$RGPD'"
    echo "AIBOX_MUTATING_TOOLS_REGEX='$MUT_REGEX'"
  } > "$COMP_DIR/company.env"
  chmod 600 "$COMP_DIR/company.env"
  # Vue lisible sans secrets (audit)
  {
    echo "entreprise: $COMPANY_NAME"
    echo "modele_local: $OLLAMA_MODEL"
    echo "cloud: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo 'anthropic haiku (+ fallback local)' || echo 'local uniquement')"
    echo "connecteurs: $ENABLED_CONNECTORS"
    echo "rgpd_scrub: $RGPD"
  } > "$COMP_DIR/company.yaml"
fi
say "config -> $COMP_DIR/company.env (+ company.yaml)"

# venvs MCP partagés (créés une fois pour toute l'entreprise)
for conn in $ENABLED_CONNECTORS; do
  d="$AIBOX_HERMES_DIR/mcp-connectors/$conn"
  if [ ! -f "$d/requirements.txt" ]; then say "(connecteur inconnu, ignoré: $conn)"; continue; fi
  run "python3 -m venv '$d/.venv'"
  run "'$d/.venv/bin/pip' install -q -r '$d/requirements.txt'"
  say "connecteur MCP partagé -> $conn"
done

echo "== OK. Ajouter un employé :  wizard-user.sh $SLUG <user> =="
