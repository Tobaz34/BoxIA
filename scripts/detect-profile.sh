#!/usr/bin/env bash
# =============================================================================
# AI Box — Détection du profil hardware
# =============================================================================
# Lit config/profiles.yaml et choisit le profil applicable selon :
#   1. nb d'utilisateurs annoncé (CLIENT_USERS_COUNT dans .env, sinon flag CLI)
#   2. matériel détecté (VRAM GPU, RAM, CPU cores)
#
# Sortie : nom du profil sur stdout (`tpe`, `pme`, `pme-plus`)
# Sortie verbeuse (-v) : rapport complet sur stderr
#
# Usage :
#   ./scripts/detect-profile.sh                      # auto depuis .env
#   ./scripts/detect-profile.sh -u 25                # forcer 25 users
#   ./scripts/detect-profile.sh -v                   # mode verbeux
#   ./scripts/detect-profile.sh --check tpe          # vérifie que HW couvre tpe
#
# Exit codes :
#   0 = profil trouvé et HW compatible
#   1 = profil trouvé mais HW INSUFFISANT (warning sur stderr)
#   2 = erreur (yaml manquant, dépendances manquantes)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROFILES_YAML="$ROOT_DIR/config/profiles.yaml"
ENV_FILE="$ROOT_DIR/.env"

VERBOSE=0
USER_COUNT=""
CHECK_PROFILE=""

# ---- Parsing arguments ------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=1; shift ;;
    -u|--users)   USER_COUNT="$2"; shift 2 ;;
    --check)      CHECK_PROFILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '4,22p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Argument inconnu: $1" >&2; exit 2 ;;
  esac
done

log() { [[ $VERBOSE -eq 1 ]] && echo "$@" >&2 || true; }
warn() { echo "[WARN] $*" >&2; }

# ---- Vérif dépendances ------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 requis pour parser le YAML" >&2
  exit 2
fi

if [[ ! -f "$PROFILES_YAML" ]]; then
  echo "[ERROR] $PROFILES_YAML introuvable" >&2
  exit 2
fi

# ---- 1. Récupération nb d'utilisateurs --------------------------------------
if [[ -z "$USER_COUNT" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    USER_COUNT=$(grep -E '^CLIENT_USERS_COUNT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
  fi
fi
USER_COUNT="${USER_COUNT:-1}"
log "→ Nombre d'utilisateurs visé : $USER_COUNT"

# ---- 2. Détection hardware --------------------------------------------------
detect_vram_gb() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    # Total VRAM en MiB → convertir en Go (décimal)
    local mib
    mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    if [[ -n "$mib" && "$mib" =~ ^[0-9]+$ ]]; then
      python3 -c "print(round($mib * 1.048576 / 1024, 1))"
      return
    fi
  fi
  echo "0"
}

detect_ram_gb() {
  # /proc/meminfo donne en kB → convertir en Go (décimal)
  if [[ -r /proc/meminfo ]]; then
    local kb
    kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    python3 -c "print(round($kb * 1.024 / 1000 / 1000, 1))"
  else
    echo "0"
  fi
}

detect_cpu_cores() {
  # Nombre de threads logiques
  if command -v nproc >/dev/null 2>&1; then
    nproc
  else
    grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "0"
  fi
}

detect_disk_gb() {
  # Espace dispo sur le filesystem racine, en Go décimaux
  df -BG / 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' || echo "0"
}

VRAM_GB=$(detect_vram_gb)
RAM_GB=$(detect_ram_gb)
CPU_CORES=$(detect_cpu_cores)
DISK_GB=$(detect_disk_gb)

log "→ Hardware détecté : ${VRAM_GB} Go VRAM / ${RAM_GB} Go RAM / ${CPU_CORES} cores / ${DISK_GB} Go disk libre"

# ---- 3. Choix du profil via Python (parse YAML) -----------------------------
chosen_profile=$(python3 - <<PYEOF
import sys
try:
    import yaml
except ImportError:
    print("__YAML_MISSING__")
    sys.exit(0)

with open("$PROFILES_YAML") as f:
    data = yaml.safe_load(f)

users = int("$USER_COUNT")
mapping = data.get("user_count_to_profile", [])
chosen = "tpe"
for entry in mapping:
    if users <= entry["max"]:
        chosen = entry["profile"]
        break
else:
    chosen = mapping[-1]["profile"] if mapping else "tpe"
print(chosen)
PYEOF
)

if [[ "$chosen_profile" == "__YAML_MISSING__" ]]; then
  warn "PyYAML manquant — fallback sur règles inline"
  if   [[ $USER_COUNT -le 5 ]];  then chosen_profile=tpe
  elif [[ $USER_COUNT -le 30 ]]; then chosen_profile=pme
  else                                 chosen_profile=pme-plus
  fi
fi

# ---- 4. Override par flag --check ------------------------------------------
[[ -n "$CHECK_PROFILE" ]] && chosen_profile="$CHECK_PROFILE"

log "→ Profil suggéré : $chosen_profile"

# ---- 5. Vérification HW vs requirements profil ------------------------------
hw_check=$(python3 - <<PYEOF
import sys
try:
    import yaml
except ImportError:
    print("__YAML_MISSING__")
    sys.exit(0)

with open("$PROFILES_YAML") as f:
    data = yaml.safe_load(f)

prof = data["profiles"].get("$chosen_profile")
if not prof:
    print(f"__UNKNOWN_PROFILE__:$chosen_profile")
    sys.exit(0)

req = prof["hardware"]
have = {
    "vram": float("$VRAM_GB"),
    "ram": float("$RAM_GB"),
    "cores": int("$CPU_CORES"),
    "disk": float("$DISK_GB"),
}

issues = []
if have["vram"] < req["vram_gb_min"]:
    issues.append(f"VRAM {have['vram']} Go < {req['vram_gb_min']} Go requis")
if have["ram"] < req["ram_gb_min"]:
    issues.append(f"RAM {have['ram']} Go < {req['ram_gb_min']} Go requis")
if have["cores"] < req["cpu_cores_min"]:
    issues.append(f"CPU {have['cores']} cores < {req['cpu_cores_min']} requis")
if have["disk"] < req["disk_gb_min"]:
    issues.append(f"Disk {have['disk']} Go < {req['disk_gb_min']} Go requis")

if issues:
    print("__HW_INSUFFICIENT__:" + " | ".join(issues))
else:
    print("__HW_OK__")
PYEOF
)

# ---- 6. Sortie + exit code --------------------------------------------------
case "$hw_check" in
  __HW_OK__)
    log "✓ Hardware compatible avec profil $chosen_profile"
    echo "$chosen_profile"
    exit 0
    ;;
  __HW_INSUFFICIENT__:*)
    issues="${hw_check#__HW_INSUFFICIENT__:}"
    warn "Profil '$chosen_profile' choisi mais hardware insuffisant : $issues"
    warn "→ Le profil sera quand même appliqué (best-effort), mais attendez-vous à des soucis de perf."
    echo "$chosen_profile"
    exit 1
    ;;
  __UNKNOWN_PROFILE__:*)
    echo "[ERROR] Profil inconnu : ${hw_check#__UNKNOWN_PROFILE__:}" >&2
    exit 2
    ;;
  __YAML_MISSING__)
    warn "PyYAML manquant pour validation HW (sortie best-effort)"
    echo "$chosen_profile"
    exit 0
    ;;
esac
