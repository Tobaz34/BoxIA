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

# 2. Whitelist : passe par le script officiel
if echo "$COMMAND" | grep -qE 'tools/deploy-to-xefia\.sh'; then
  exit 0
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
