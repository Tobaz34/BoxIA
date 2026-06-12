#!/usr/bin/env bash
# lib/hermes-config.sh — applique la configuration Hermes (provider, fallback, skills)
# Idempotent. Source-é par install.sh après que le container Hermes soit healthy.
set -euo pipefail

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

HERMES_BIN='/opt/hermes/.venv/bin/hermes'
HERMES_CONTAINER='aibox-hermes'
MODEL_LOCAL_DERIVED='qwen3:14b-64k'
NUM_CTX=65536
OLLAMA_URL='http://ollama:11434/v1'

# Crée le modèle dérivé qwen3:14b-64k via Modelfile (idempotent)
create_local_derived_model() {
  log "Modèle local dérivé $MODEL_LOCAL_DERIVED"
  local present
  present=$(docker exec ollama ollama list 2>/dev/null | awk "NR>1 && \$1==\"$MODEL_LOCAL_DERIVED\" {print \"YES\"; exit}" || echo NO)
  if [ "$present" = "YES" ]; then
    ok "$MODEL_LOCAL_DERIVED déjà présent"
    return 0
  fi
  log "Création $MODEL_LOCAL_DERIVED via Modelfile"
  # Vérifie que qwen3:14b est pullé
  if ! docker exec ollama ollama list | awk 'NR>1 {print $1}' | grep -q '^qwen3:14b$'; then
    log "Pull qwen3:14b (long, ~9 Go)"
    docker exec ollama ollama pull qwen3:14b
  fi
  printf "FROM qwen3:14b\nPARAMETER num_ctx $NUM_CTX\n" | docker exec -i ollama sh -c "cat > /tmp/Modelfile.qwen3-64k"
  docker exec ollama ollama create "$MODEL_LOCAL_DERIVED" -f /tmp/Modelfile.qwen3-64k
  ok "$MODEL_LOCAL_DERIVED créé"
}

# Configure Hermes selon le provider cloud choisi
configure_provider() {
  local provider="$1"
  log "Configuration provider Hermes : $provider"
  case "$provider" in
    anthropic)
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.provider anthropic >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.default claude-haiku-4-5-20251001 >/dev/null
      ;;
    openrouter)
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.provider openrouter >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.default anthropic/claude-haiku-4.5 >/dev/null
      ;;
    gemini)
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.provider gemini >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.default gemini-2.5-flash >/dev/null
      ;;
    openai)
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.provider openai >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.default gpt-4o-mini >/dev/null
      ;;
    local|none)
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.provider custom >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.base_url "$OLLAMA_URL" >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.default "$MODEL_LOCAL_DERIVED" >/dev/null
      docker exec "$HERMES_CONTAINER" $HERMES_BIN config set model.context_length $NUM_CTX >/dev/null
      ;;
    *) fail "Provider inconnu : $provider" ;;
  esac
  # Auxiliary compression : si cloud, utilise le même; si local, override
  if [ "$provider" = "local" ] || [ "$provider" = "none" ]; then
    docker exec "$HERMES_CONTAINER" $HERMES_BIN config set auxiliary.compression.model "$MODEL_LOCAL_DERIVED" >/dev/null
    docker exec "$HERMES_CONTAINER" $HERMES_BIN config set auxiliary.compression.context_length $NUM_CTX >/dev/null
    docker exec "$HERMES_CONTAINER" $HERMES_BIN config set auxiliary.compression.base_url "$OLLAMA_URL" >/dev/null
    docker exec "$HERMES_CONTAINER" $HERMES_BIN config set auxiliary.compression.provider custom >/dev/null
  fi
  ok "Provider configuré"
}

# Configure le fallback local quand le primary est cloud
configure_fallback_local() {
  local primary="$1"
  if [ "$primary" = "local" ] || [ "$primary" = "none" ]; then
    return 0  # pas de fallback à ajouter
  fi
  log "Configuration fallback local (Ollama)"
  docker exec "$HERMES_CONTAINER" $HERMES_BIN fallback add custom "$MODEL_LOCAL_DERIVED" \
    --base-url "$OLLAMA_URL" --priority 2 2>&1 | tail -3 \
    || warn "fallback add a échoué (peut-être déjà présent)"
  ok "Fallback local configuré"
}

# Installe les skills custom AI Box dans le volume Hermes
install_aibox_skills() {
  local repo_dir="$1"
  local skills_src="$repo_dir/aibox-host/skills"
  local skills_dest="/opt/aibox/hermes/data/skills"
  log "Installation skills AI Box"
  if [ ! -d "$skills_src" ]; then
    warn "Dossier skills source absent : $skills_src — skip"
    return 0
  fi
  mkdir -p "$skills_dest"
  cp -r "$skills_src"/* "$skills_dest/" 2>/dev/null || true
  # Chown au user hermes (UID 10000)
  chown -R 10000:10000 "$skills_dest" 2>/dev/null || true
  ok "Skills AI Box installés ($(ls "$skills_src" | wc -l) trouvés)"
}
