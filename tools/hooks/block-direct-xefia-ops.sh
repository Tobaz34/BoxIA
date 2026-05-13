#!/usr/bin/env bash
# =============================================================================
# block-direct-xefia-ops.sh
# -----------------------------------------------------------------------------
# Hook PreToolUse(Bash) qui bloque tout SSH vers xefia qui modifie l'état du
# serveur, sauf via le pipeline officiel `tools/deploy-to-xefia.sh`.
#
# RAISON D'ÊTRE : voir CLAUDE.md (3 règles d'or) — incident 2026-05-03 où
# 4 sessions parallèles ont créé un chaos d'état serveur impossible à
# reset, parce qu'on bypassait git via scp/cp/edits in-place.
#
# MÉCANIQUE :
#   stdin = JSON Claude hooks (tool_input.command = la commande Bash)
#   exit 0 = laisse passer
#   exit 2 = bloque ET le message stderr est renvoyé à Claude
#
# RÈGLES :
#   1. Pas de SSH vers xefia/192.168.15.210     → laisse passer
#   2. Commande contient `tools/deploy-to-xefia.sh` → laisse passer (whitelist)
#   3. SSH xefia + un des patterns interdits ci-dessous → bloque
#   4. SSH xefia avec lecture seule (docker ps, cat, git status…) → laisse passer
# =============================================================================
set -e

# Parse stdin JSON avec node (portable : tout dev Next.js a node).
# Pas jq qui n'est pas installé par défaut sur Git Bash Windows.
COMMAND=$(node -p 'try { JSON.parse(require("fs").readFileSync(0,"utf8"))?.tool_input?.command || "" } catch { "" }' 2>/dev/null)

# 1. Pas de cible xefia → on s'en fout
# (note: scp utilise le protocole ssh mais s'écrit `scp ...host:...`, pas
# `ssh ...`, donc on matche aussi sur `scp ` au début ou après `|/&&/;`)
if ! echo "$COMMAND" | grep -qE '(ssh|scp).*(xefia|192\.168\.15\.210)'; then
  exit 0
fi

# 2. Whitelist : passe par un script officiel de la pipeline
# - deploy-to-xefia       : redéploie aibox-app (rebuild ciblé + migrations)
# - deploy-new-box        : déploie sur une box neuve (rsync + creds + install BOOTSTRAP)
# - provision-master-creds : pousse /etc/aibox-master/cloudflare.env via scp+sudo
# - wipe-box              : reset destructif d'une box (containers + volumes)
# - start-connector       : lance un container connecteur ad-hoc
if echo "$COMMAND" | grep -qE 'tools/(deploy-to-xefia|deploy-new-box|provision-master-creds|wipe-box|redeploy-wizard|start-connector)\.sh'; then
  exit 0
fi

# 2bis. Exemption Hermes Agent (stack_xefia Portainer, hors scope BoxIA /srv/ai-stack/)
#
# Contexte : sur le même serveur xefia (192.168.15.210) coexistent DEUX stacks :
#   - /srv/ai-stack/   = BoxIA (ce repo, géré via deploy-to-xefia.sh)
#   - /srv/xefia/      = stack_xefia Portainer (AnythingLLM, Open-WebUI, OpenClaw,
#                        Ollama partagé, Hermes Agent, etc.) — NON versionné dans
#                        ce repo, géré via Portainer.
#
# L'intégration Hermes Agent vit dans /srv/xefia/hermes/ (compose) et
# /srv/xefia/hermes_data/ (volume). Ces paths sont hors scope BoxIA :
# pas de risque de dériver l'état git de /srv/ai-stack/.
#
# RÈGLE : si TOUS les paths /srv/... d'une commande sont préfixés par
# /srv/xefia/hermes ou /srv/xefia/hermes_data (et aucun ".." de bypass),
# on laisse passer — y compris docker compose up/down et redirect writes.
if ! echo "$COMMAND" | grep -qE '\.\.(/|$)'; then
  SRV_PATHS=$(echo "$COMMAND" | grep -oE '/srv/[A-Za-z0-9_./-]+' | sort -u)
  if [ -n "$SRV_PATHS" ]; then
    ALL_HERMES=true
    while IFS= read -r p; do
      if ! echo "$p" | grep -qE '^/srv/xefia/hermes(_data)?(/|$)'; then
        ALL_HERMES=false
        break
      fi
    done <<< "$SRV_PATHS"
    # docker compose ciblé sur le compose Hermes → autorisé même sans path /srv/ explicite
    if echo "$COMMAND" | grep -qE 'docker[[:space:]]+compose[[:space:]]+-f[[:space:]]+/srv/xefia/hermes/'; then
      ALL_HERMES=true
    fi
    if [ "$ALL_HERMES" = "true" ]; then
      exit 0
    fi
  fi
fi

# 3. Détection des patterns interdits (premier match gagne)
PATTERN=""
REASON=""

if echo "$COMMAND" | grep -qE 'scp '; then
  PATTERN="scp"
  REASON="Upload de fichiers via scp (utilise git push + tools/deploy-to-xefia.sh)"
elif echo "$COMMAND" | grep -qE 'docker[[:space:]]+compose.*(build|up|down|restart|stop|start|kill|rm)'; then
  PATTERN="docker compose mutatif"
  REASON="docker compose build/up/down/restart sur xefia. Le script gère le rebuild ciblé."
elif echo "$COMMAND" | grep -qE 'git[[:space:]]+(reset|checkout|pull|merge|rebase|push|fetch[[:space:]]+--all)'; then
  PATTERN="git mutation"
  REASON="Mutation git directe sur xefia. Le script s'occupe du reset propre."
elif echo "$COMMAND" | grep -qE '(\./)?install\.sh'; then
  PATTERN="install.sh"
  REASON="install.sh est destructif (re-provisionne tout). Hors-pipeline."
elif echo "$COMMAND" | grep -qE '(\./)?reset-as-client'; then
  PATTERN="reset-as-client"
  REASON="reset-as-client.sh efface les données client. Confirmation utilisateur explicite requise hors hook."
elif echo "$COMMAND" | grep -qE 'rm[[:space:]]+-rf[[:space:]]+/srv'; then
  PATTERN="rm -rf /srv"
  REASON="Destruction massive de /srv interdite."
elif echo "$COMMAND" | grep -qE '(>|>>)[[:space:]]*/srv/'; then
  PATTERN="redirect write vers /srv"
  REASON="Redirect write (>) vers /srv contourne git. Utilise git push + script."
elif echo "$COMMAND" | grep -qE 'tee[[:space:]].*/srv/'; then
  PATTERN="tee vers /srv"
  REASON="tee vers /srv contourne git. Utilise git push + script."
elif echo "$COMMAND" | grep -qE 'psql.*-c[^|]*(UPDATE|INSERT|DELETE|TRUNCATE|DROP|CREATE|ALTER)'; then
  PATTERN="psql mutation ad-hoc"
  REASON="Mutation DB live ad-hoc. Crée une migration dans tools/migrations/."
fi

if [ -n "$PATTERN" ]; then
  {
    echo "🛑 BLOQUÉ par hook block-direct-xefia-ops.sh"
    echo ""
    echo "Pattern interdit : $PATTERN"
    echo "Raison           : $REASON"
    echo ""
    echo "Commande détectée :"
    echo "  $COMMAND" | head -3
    echo ""
    echo "Pour déployer : tools/deploy-to-xefia.sh <branche>"
    echo "Pour muter la DB : créer un fichier dans tools/migrations/"
    echo ""
    echo "Détails complets : voir CLAUDE.md à la racine du repo."
  } >&2
  exit 2
fi

# SSH xefia avec une commande non-mutative (docker ps, cat, git status, etc.) → OK
exit 0
