#!/usr/bin/env bash
# lib/prereqs.sh — vérifie les pré-requis matériels et OS
# Source-é par aibox-host/install.sh. Exit 1 si KO.
set -euo pipefail

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

check_os() {
  log "OS check"
  [ -f /etc/os-release ] || fail "Pas de /etc/os-release — OS non supporté"
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ok "OS : $PRETTY_NAME" ;;
    *) fail "OS non supporté : $ID (testé sur Ubuntu 22.04+ et Debian 12+)" ;;
  esac
  # Version min Ubuntu 22.04 ou Debian 12
  case "$ID-$VERSION_ID" in
    ubuntu-2[2-9].*|ubuntu-3*|debian-1[2-9]|debian-2*) ok "Version OS supportée" ;;
    *) warn "Version OS non testée : $VERSION_ID — install peut échouer" ;;
  esac
}

check_cpu_ram() {
  log "CPU + RAM check"
  local cores ram_gb
  cores=$(nproc)
  ram_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
  ok "CPU : $cores cores"
  ok "RAM : ${ram_gb} Go"
  [ "$cores" -ge 4 ] || warn "Recommandé : 8+ cores (vu : $cores)"
  [ "$ram_gb" -ge 16 ] || warn "Recommandé : 32 Go (vu : ${ram_gb} Go) — Ollama + Hermes + Dify auront du mal"
  [ "$ram_gb" -ge 8 ] || fail "Minimum absolu : 16 Go (vu : ${ram_gb} Go)"
}

check_disk() {
  log "Disque check"
  local free_gb
  free_gb=$(df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
  ok "Disque libre / : ${free_gb} Go"
  [ "$free_gb" -ge 60 ] || fail "Minimum : 60 Go libres (vu : ${free_gb} Go) — modèles Ollama + images Docker = ~40 Go"
}

check_gpu() {
  log "GPU NVIDIA check"
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    warn "nvidia-smi absent — pas de GPU détecté. Ollama tournera en CPU (très lent). Le mode hybride cloud est fortement recommandé."
    export AIBOX_GPU_AVAILABLE=0
    return 0
  fi
  local gpu_name vram_mb
  gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  vram_mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  ok "GPU : $gpu_name (${vram_mb} MiB)"
  if [ "$vram_mb" -lt 8000 ]; then
    warn "VRAM <8 Go : choix LLM local limités. Cloud LLM recommandé."
  fi
  export AIBOX_GPU_AVAILABLE=1
}

check_network() {
  log "Réseau check"
  if curl -fsSI --max-time 5 https://hub.docker.com >/dev/null 2>&1; then
    ok "Internet OK (Docker Hub joignable)"
  else
    warn "Internet KO ou Docker Hub bloqué — pull d'images échouera"
  fi
}

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "Ce script doit être lancé en root (sudo). Relance : sudo $0"
  fi
  ok "Lancé en root"
}

run_all_prereqs() {
  # Mode --check : skip check_root (lecture seule, pas besoin d'élévation)
  if [ "${CHECK_ONLY:-0}" != "1" ]; then
    check_root
  fi
  check_os
  check_cpu_ram
  check_disk
  check_gpu
  check_network
  ok "Pré-requis validés"
}
