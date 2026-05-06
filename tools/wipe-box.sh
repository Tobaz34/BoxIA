#!/usr/bin/env bash
# =============================================================================
# tools/wipe-box.sh
# -----------------------------------------------------------------------------
# Réinitialise une AI Box à l'état "fresh install" en supprimant :
#   - Tous les containers aibox-* (et services associés type ollama, postgres)
#   - Tous les volumes Docker des composes du projet
#   - Les networks aibox_net et ollama_net
#   - Les fichiers de config dans /srv/ai-stack/ (.env, client_config.yaml,
#     deploy.log, data/configured)
#
# PRÉSERVE :
#   - /etc/aibox-master/cloudflare.env (master credentials BoxIA — survit aux
#     wipes par design, hors /srv/ai-stack/)
#   - Les images Docker (gain de temps : pas de re-pull au prochain install)
#   - /srv/ai-stack/data/* à part le marker `configured` (les données métier
#     comme audit.jsonl, agents installés, etc. sont conservées par défaut —
#     utiliser --wipe-data pour aussi les supprimer)
#   - Le code source du repo (pas touché — sera resynchronisé au prochain
#     deploy-new-box.sh)
#
# Usage :
#   ./tools/wipe-box.sh <ssh-target> [--wipe-data] [--keep-images] [--yes]
#
# Options :
#   --wipe-data    Supprime aussi /srv/ai-stack/data/* (audit, état applicatif)
#   --keep-images  (default) ne touche pas aux images Docker
#   --wipe-images  Force docker image prune -af (lent à re-pull, ~25 GB)
#   --yes          Skip la confirmation (utile en CI ou enchaînement de scripts)
#
# Exit codes :
#   0 : wipe réussi
#   1 : erreur SSH
#   2 : abandon utilisateur
# =============================================================================
set -euo pipefail

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*" >&2; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*" >&2; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*" >&2; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }
hr()       { printf "%.0s─" {1..70} >&2; printf "\n" >&2; }

# ---- Args ------------------------------------------------------------------
SSH_TARGET=""
WIPE_DATA=0
WIPE_IMAGES=0
SKIP_CONFIRM=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wipe-data)   WIPE_DATA=1;    shift ;;
    --wipe-images) WIPE_IMAGES=1;  shift ;;
    --keep-images) WIPE_IMAGES=0;  shift ;;
    --yes|-y)      SKIP_CONFIRM=1; shift ;;
    -h|--help)
      sed -n '4,40p' "$0"
      exit 0
      ;;
    -*)
      c_red "Argument inconnu : $1"
      exit 1
      ;;
    *)
      if [[ -z "$SSH_TARGET" ]]; then
        SSH_TARGET="$1"
      else
        c_red "Argument inattendu : $1"
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$SSH_TARGET" ]]; then
  c_red "Usage : $0 <ssh-target> [--wipe-data] [--wipe-images] [--yes]"
  c_red "Exemple : $0 clikinfo@192.168.15.210 --yes"
  exit 1
fi

REMOTE_PATH="${REMOTE_PATH:-/srv/ai-stack}"

# ---- Bannière + confirmation -----------------------------------------------
c_yellow "════════════════════════════════════════════════════════════════════"
c_yellow "  AI BOX — WIPE COMPLET (destructif)"
c_yellow "════════════════════════════════════════════════════════════════════"
c_yellow "  → Cible      : $SSH_TARGET"
c_yellow "  → Path       : $REMOTE_PATH"
c_yellow "  → Wipe data  : $([[ $WIPE_DATA -eq 1 ]] && echo OUI || echo non)"
c_yellow "  → Wipe images: $([[ $WIPE_IMAGES -eq 1 ]] && echo OUI || echo non)"
c_yellow ""
c_yellow "Tous les containers + volumes Docker de la stack BoxIA seront"
c_yellow "détruits. /etc/aibox-master/cloudflare.env est préservé."
c_yellow "════════════════════════════════════════════════════════════════════"

if [[ $SKIP_CONFIRM -eq 0 ]]; then
  read -rp "Confirmer le wipe ? (tape 'yes' pour continuer) : " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    c_red "Abandon."
    exit 2
  fi
fi

# ---- Test SSH --------------------------------------------------------------
c_blue "→ Test connexion SSH..."
if ! ssh -o ConnectTimeout=10 "$SSH_TARGET" "test -d $REMOTE_PATH" 2>/dev/null; then
  c_red "✗ SSH KO ou $REMOTE_PATH n'existe pas sur la box."
  exit 1
fi
c_green "  ✓ SSH OK + $REMOTE_PATH présent"

# ---- Wipe via script remote ------------------------------------------------
hr
c_blue "→ Lancement du wipe sur $SSH_TARGET..."

# On envoie le script via un argument inline (pas de heredoc, pas de TTY needed
# car on n'utilise pas sudo — les volumes/containers Docker sont gérés par
# l'user clikinfo qui est dans le groupe docker).
ssh "$SSH_TARGET" "
  set +e  # on continue même si certains composes échouent (pas tous présents)
  cd $REMOTE_PATH

  echo
  echo '=== Stop tous les composes ==='
  for compose in services/*/docker-compose.yml docker-compose.yml; do
    if [ -f \"\$compose\" ]; then
      echo \"  → \$compose\"
      docker compose -f \"\$compose\" down -v --remove-orphans 2>&1 | tail -3
    fi
  done

  echo
  echo '=== Stop containers résiduels (filet de sécu) ==='
  CONTAINERS=\$(docker ps -aq --filter 'name=aibox-')
  if [ -n \"\$CONTAINERS\" ]; then
    echo \"\$CONTAINERS\" | xargs docker rm -f
  else
    echo '  (aucun)'
  fi

  echo
  echo '=== Suppression EXPLICITE des volumes BoxIA (au-delà du prune) ==='
  # Le \`compose down -v\` ne supprime QUE les volumes nommés DÉCLARÉS dans le
  # compose. Pas ceux \`external: true\` ni ceux d'un autre projet. Or BoxIA
  # a plusieurs volumes external (authentik_postgres_data, n8n_data, etc.)
  # qui contiennent des secrets persistés (passwords PG, encryption keys n8n).
  #
  # Sans wipe explicite, au redeploy avec un nouveau .env :
  #   - PG container : utilise le password du volume (ancien)
  #   - App container : utilise le password du .env (nouveau)
  #   → "FATAL: password authentication failed"  (langfuse, agents, etc.)
  # OU :
  #   - n8n config dans /home/node/.n8n/config a une encryption key (ancienne)
  #   - n8n env a N8N_ENCRYPTION_KEY (nouvelle ou non set)
  #   → "Mismatching encryption keys" → restart loop
  #
  # On supprime tous les volumes commençant par les préfixes BoxIA connus :
  #   aibox- aibox_ observability_
  # Les volumes 'stack_xefia_*' (anythingllm, npm, dashy externes à BoxIA)
  # sont préservés. Les volumes anonymes (hashes longs) seront pris par prune.
  AIBOX_VOLUMES=\$(docker volume ls --format '{{.Name}}' | grep -E '^(aibox[-_]|observability_)' || true)
  if [ -n \"\$AIBOX_VOLUMES\" ]; then
    echo \"\$AIBOX_VOLUMES\" | xargs docker volume rm 2>&1 | tail -10
  else
    echo '  (aucun volume BoxIA à supprimer)'
  fi
  echo
  echo '=== Prune des volumes orphelins (anonymes/hashes) ==='
  docker volume prune -af 2>&1 | tail -3

  echo
  echo '=== Suppression networks aibox_net + ollama_net ==='
  docker network rm aibox_net ollama_net 2>&1 | tail -3

  echo
  echo '=== Cleanup fichiers config ==='
  rm -fv .env client_config.yaml deploy.log .deploy.lock data/configured 2>/dev/null || true

  if [ '$WIPE_DATA' = '1' ]; then
    echo
    echo '=== --wipe-data : suppression /srv/ai-stack/data/ ==='
    rm -rf data/* data/.* 2>/dev/null || true
  else
    echo
    echo '=== /srv/ai-stack/data/ préservé (utilise --wipe-data pour wiper aussi) ==='
  fi

  if [ '$WIPE_IMAGES' = '1' ]; then
    echo
    echo '=== --wipe-images : prune des images Docker ==='
    docker image prune -af 2>&1 | tail -3
  else
    echo
    echo '=== Images Docker préservées (utilise --wipe-images pour les supprimer) ==='
  fi

  echo
  echo '=== État final ==='
  echo '  Containers restants :'
  docker ps -a --format '    {{.Names}}\t{{.Status}}' | head -20
  echo '  Networks restants :'
  docker network ls --format '    {{.Name}}' | grep -E 'aibox|ollama' || echo '    (aucun aibox*/ollama*)'
  echo '  Espace disque :'
  df -h $REMOTE_PATH | tail -1 | awk '{print \"    \" \$0}'
  echo

  exit 0
"
WIPE_RC=$?

if [[ $WIPE_RC -ne 0 ]]; then
  c_red "✗ Le script remote a renvoyé exit $WIPE_RC"
  exit 1
fi

# Vérification : /etc/aibox-master/cloudflare.env est-il toujours là ?
hr
c_blue "→ Vérification que les master credentials sont préservés..."
if ssh "$SSH_TARGET" "sudo -n test -f /etc/aibox-master/cloudflare.env 2>/dev/null"; then
  c_green "  ✓ /etc/aibox-master/cloudflare.env présent (master creds OK)"
elif ssh "$SSH_TARGET" "test -r /etc/aibox-master/cloudflare.env 2>/dev/null"; then
  c_green "  ✓ /etc/aibox-master/cloudflare.env présent (lecture OK)"
else
  c_yellow "  ⚠ Impossible de vérifier (sudo non NOPASSWD). Vérifie manuellement :"
  c_yellow "    ssh $SSH_TARGET 'sudo ls -la /etc/aibox-master/cloudflare.env'"
fi

hr
c_green "╔══════════════════════════════════════════════════════════════════╗"
c_green "║                    ✓ WIPE TERMINÉ                                  ║"
c_green "╚══════════════════════════════════════════════════════════════════╝"
c_green ""
c_green "Prochaine étape : redéployer une fresh install via"
c_green "  ./tools/deploy-new-box.sh $SSH_TARGET --skip-docker --skip-creds"
