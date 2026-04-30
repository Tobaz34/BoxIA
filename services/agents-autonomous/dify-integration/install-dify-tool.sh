#!/usr/bin/env bash
# =============================================================================
# Provisionne le custom tool "AI Box Agents" dans Dify via son API admin.
# =============================================================================
# Idempotent : si le tool existe déjà, on update son schema. Sinon on crée.
#
# Prérequis :
#   - DIFY_CONSOLE_URL (ex: http://localhost:8081)
#   - DIFY_CONSOLE_TOKEN (Bearer admin — récupéré via /console/api/login)
#   - AGENTS_API_KEY (pour la config du tool — sera injecté côté Dify pour auth)
#
# Usage : DIFY_CONSOLE_TOKEN=xxx AGENTS_API_KEY=yyy ./install-dify-tool.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/openapi-tool.yaml"

DIFY_URL="${DIFY_CONSOLE_URL:-http://localhost:8081}"
DIFY_TOKEN="${DIFY_CONSOLE_TOKEN:?DIFY_CONSOLE_TOKEN required (admin Bearer)}"
AGENTS_KEY="${AGENTS_API_KEY:?AGENTS_API_KEY required}"
TOOL_NAME="${TOOL_NAME:-AI Box Agents}"

[[ -f "$SCHEMA_FILE" ]] || { echo "[ERROR] $SCHEMA_FILE introuvable"; exit 2; }

SCHEMA_CONTENT=$(python3 -c "import json; print(json.dumps(open('$SCHEMA_FILE').read()))")

echo "→ Récupération du workspace_id…"
WORKSPACE_ID=$(curl -fsSL -H "Authorization: Bearer $DIFY_TOKEN" \
    "$DIFY_URL/console/api/workspaces/current" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  workspace_id=$WORKSPACE_ID"

echo "→ Recherche du provider \"$TOOL_NAME\" existant…"
EXISTING=$(curl -fsSL -H "Authorization: Bearer $DIFY_TOKEN" \
    "$DIFY_URL/console/api/workspaces/current/tool-provider/api/list" 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data:
    if p.get('name') == '$TOOL_NAME':
        print(p.get('id', ''))
        break
" || echo "")

CREDENTIALS_JSON=$(python3 -c "
import json
print(json.dumps({
    'auth_type': 'api_key',
    'api_key_header': 'Authorization',
    'api_key_value': 'Bearer $AGENTS_KEY',
    'api_key_header_prefix': 'no_prefix',
}))
")

PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'provider': '$TOOL_NAME',
    'original_provider': '$TOOL_NAME',
    'icon': {'background': '#3b82f6', 'content': '🤖'},
    'credentials': $CREDENTIALS_JSON,
    'schema_type': 'openapi',
    'schema': $SCHEMA_CONTENT,
    'privacy_policy': '',
    'custom_disclaimer': 'Service interne AI Box. Bearer token requis.',
    'labels': ['agents', 'aibox'],
}))
")

if [[ -n "$EXISTING" ]]; then
    echo "→ Update du provider existant (id=$EXISTING)…"
    curl -fsSL -X POST \
        -H "Authorization: Bearer $DIFY_TOKEN" \
        -H "Content-Type: application/json" \
        "$DIFY_URL/console/api/workspaces/current/tool-provider/api/update" \
        -d "$PAYLOAD" | python3 -m json.tool
else
    echo "→ Création du provider…"
    curl -fsSL -X POST \
        -H "Authorization: Bearer $DIFY_TOKEN" \
        -H "Content-Type: application/json" \
        "$DIFY_URL/console/api/workspaces/current/tool-provider/api/add" \
        -d "$PAYLOAD" | python3 -m json.tool
fi

echo
echo "✓ Tool provisionné. Vérifie dans la console Dify :"
echo "  $DIFY_URL/tools (section Custom)"
echo
echo "Pour utiliser : crée un Workflow → drag-and-drop \"AI Box Agents → triageEmail\""
