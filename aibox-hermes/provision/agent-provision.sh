#!/usr/bin/env bash
# =============================================================================
# Provisionne un AGENT MÉTIER AUTONOME (pas de chat webui) sur la stack Hermes.
# Chaque agent = instance Hermes isolée : HERMES_HOME propre, connecteurs RBAC,
# persona (SOUL.md), gateway dédié (aibox-gateway@agt-<slug>, avec
# AIBOX_APPROVAL_AUTO=1 hérité du unit), et une routine cron qui surveille son
# dossier de routage AI-<métier>. Idempotent.
#
# Usage (env) :
#   AGENT=technique  AGENT_CONNECTORS="odoo,email-msgraph,email-ews"
#   AGENT_ROLE="agent Technique/SOC : incidents, tickets Odoo helpdesk"
#   AGENT_SCHEDULE="*/30 6-17 * * 1-5"  AGENT_SKILLS="aibox-email-triage"
#   AGENT_PROMPT="Traite les emails du dossier AI-Technique ..."
#   [AGENT_MODEL=claude-sonnet-4-6] [AGENT_PROVIDER=anthropic]
#   bash agent-provision.sh
# Pré-requis : andre déjà provisionné (on hérite ses secrets .env), unit
#   aibox-gateway@.service installé.
# =============================================================================
set -euo pipefail
OWNER=clikinfo
AROOT=/home/$OWNER/aibox
COMPANY=demo
AH=/home/$OWNER/BoxIA/aibox-hermes
HV=/home/$OWNER/hermes-agent/venv/bin/python
HB=/home/$OWNER/hermes-agent/venv/bin/hermes
REF_ENV=$AROOT/companies/$COMPANY/users/andre/hermes/.env   # source des secrets

: "${AGENT:?AGENT requis}"; : "${AGENT_CONNECTORS:?}"; : "${AGENT_ROLE:?}"
: "${AGENT_SCHEDULE:?}"; : "${AGENT_SKILLS:?}"; : "${AGENT_PROMPT:?}"
AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-4-6}"; AGENT_PROVIDER="${AGENT_PROVIDER:-anthropic}"
INST="agt-$AGENT"
HH=$AROOT/companies/$COMPANY/agents/$AGENT/hermes
echo "== Provision agent '$AGENT' -> $HH =="
mkdir -p "$HH/plugins"

# 1) config.yaml (RBAC connecteurs + fallback cloud + cron_mode allow). Les secrets
#    des connecteurs sont bakés depuis le .env de référence (render lit os.environ).
set -a; . "$REF_ENV"; set +a
"$HV" "$AH/provision/render_config.py" \
  --model "${OLLAMA_MODEL:-qwen3:8b}" --base-url "${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}" \
  --connectors "$AGENT_CONNECTORS" --tenant-dir "$AH" \
  --cloud-fallback-model "$AGENT_MODEL" --cron-mode allow > "$HH/config.yaml"
echo "  config.yaml (connecteurs: $AGENT_CONNECTORS)"

# 2) .env : hérite les secrets d'andre (isolation via connecteurs/skill ; durcir
#    plus tard avec des comptes techniques Odoo dédiés par agent).
[ -f "$HH/.env" ] || { install -m 600 "$REF_ENV" "$HH/.env"; }
echo "  .env"

# 3) SOUL.md : persona de l'agent
cat > "$HH/SOUL.md" <<EOF
# CLIKINFO — $AGENT_ROLE

Tu es un **agent autonome** spécialisé : $AGENT_ROLE.
Tu traites UNIQUEMENT ton périmètre (ton dossier de routage) et tes outils métier.
Réponds en français, factuel et concis. Toute action hors de ton périmètre : ignore.
EOF
echo "  SOUL.md"

# 4) plugins sécurité
for p in aibox-approval aibox-rgpd aibox-audit; do
  ln -sfn "$AH/plugins/$p" "$HH/plugins/$p"
  HERMES_HOME="$HH" "$HB" plugins enable "$p" >/dev/null 2>&1 || true
done
echo "  plugins sécurité activés"

# 5) gateway dédié (env + service)
mkdir -p "$AROOT/gateway"
echo "HERMES_HOME=$HH" > "$AROOT/gateway/$INST.env"
sudo systemctl enable "aibox-gateway@$INST" >/dev/null 2>&1 || true
sudo systemctl restart "aibox-gateway@$INST"
echo "  gateway aibox-gateway@$INST : $(systemctl is-active aibox-gateway@$INST 2>/dev/null)"

# 6) routine cron (créée en PAUSE ; modèle Claude par job)
SKILL_ARGS=""; for s in ${AGENT_SKILLS//,/ }; do SKILL_ARGS="$SKILL_ARGS --skill $s"; done
HERMES_HOME="$HH" "$HB" cron create "$AGENT_SCHEDULE" "$AGENT_PROMPT" \
  --name "$AGENT" $SKILL_ARGS --deliver local >/dev/null 2>&1 || true
JID=$("$HV" -c "import json,sys;print(next((j['id'] for j in json.load(open('$HH/cron/jobs.json'))['jobs'] if j['name']=='$AGENT'),''))" 2>/dev/null)
if [ -n "$JID" ]; then
  "$HV" - "$HH/cron/jobs.json" "$AGENT_MODEL" "$AGENT_PROVIDER" <<'PYEOF'
import sys,json
p,mdl,prov=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p));
for j in d["jobs"]:
    if j["name"] and j.get("model") is None: j["model"]=mdl; j["provider"]=prov
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PYEOF
  HERMES_HOME="$HH" "$HB" cron pause "$JID" >/dev/null 2>&1 || true
  echo "  routine '$AGENT' créée (Claude, EN PAUSE) id=$JID"
fi
echo "== OK agent '$AGENT' provisionné (autonome, routine en pause) =="
