#!/usr/bin/env bash
# lib/docker-setup.sh — installe Docker + NVIDIA Container Toolkit si nécessaires
# Idempotent (skip si déjà installé).
set -euo pipefail

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

install_docker() {
  log "Docker check / install"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker + Compose déjà installés"
    return 0
  fi
  log "Installation Docker via script officiel"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installé"
  # Add the invoking user (or 'aibox' if running as root) to the docker group
  local target_user="${SUDO_USER:-${AIBOX_USER:-aibox}}"
  if id "$target_user" >/dev/null 2>&1; then
    usermod -aG docker "$target_user"
    ok "User $target_user ajouté au groupe docker (re-login requis pour effet)"
  fi
}

install_nvidia_toolkit() {
  if [ "${AIBOX_GPU_AVAILABLE:-0}" != "1" ]; then
    warn "Pas de GPU détecté — skip NVIDIA Container Toolkit"
    return 0
  fi
  log "NVIDIA Container Toolkit check"
  if docker info 2>/dev/null | grep -q "Runtimes:.*nvidia"; then
    ok "NVIDIA runtime déjà configuré pour Docker"
    return 0
  fi
  log "Installation NVIDIA Container Toolkit"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
  ok "NVIDIA Container Toolkit installé + Docker redémarré"
  # Smoke test
  if docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
    ok "GPU accessible depuis Docker (smoke test OK)"
  else
    warn "Smoke test GPU dans container échoué — vérifier nvidia-smi + driver host"
  fi
}

ensure_docker_running() {
  systemctl is-active --quiet docker || systemctl start docker
  ok "Docker daemon up"
}

setup_docker_full() {
  install_docker
  ensure_docker_running
  install_nvidia_toolkit
}
