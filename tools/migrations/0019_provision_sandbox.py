"""Migration 0019 — démarre aibox-sandbox avec runtime runc (fallback gVisor).

Bug fresh install xefia 2026-05-07 : `aibox-sandbox` n'a jamais démarré
car le compose demande `runtime: ${SANDBOX_RUNTIME:-runsc}` et gVisor
(`runsc`) n'est pas installé sur Ubuntu standard. install.sh swallow
l'erreur via `2>/dev/null` → silence, sandbox absent, tool `bash_exec`
indisponible.

Cette migration :
1. S'assure que `SANDBOX_RUNTIME=runc` est dans /srv/ai-stack/.env
   (fallback safe — sécurité dégradée vs gVisor mais service up)
2. Vérifie si gVisor est installé sur le host (which runsc) →
   si oui, override SANDBOX_RUNTIME=runsc (mode sécurisé)
3. docker compose up -d sandbox

Idempotent : is_applied() True si container aibox-sandbox running.

Pour passer en mode gVisor sécurisé plus tard :
  sudo apt install runsc && sudo runsc install && sudo systemctl restart docker
  sed -i 's/SANDBOX_RUNTIME=runc/SANDBOX_RUNTIME=runsc/' /srv/ai-stack/.env
  cd /srv/ai-stack/services/sandbox && docker compose up -d --force-recreate
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

DESCRIPTION = "Démarre aibox-sandbox avec runtime runc (fallback si gVisor absent)"

ENV_PATH = Path(os.environ.get("AIBOX_ENV", "/srv/ai-stack/.env"))


def _read_env_var(key: str) -> str:
    if not ENV_PATH.exists():
        return ""
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith(f"{key}=") and not line.startswith("#"):
            return line.split("=", 1)[1].strip("'\"")
    return ""


def _write_env_var(key: str, value: str) -> None:
    txt = ENV_PATH.read_text() if ENV_PATH.exists() else ""
    lines = txt.splitlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith(f"{key}=") and not line.startswith("#"):
            lines[i] = f"{key}={value}"
            found = True
            break
    if not found:
        lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")


def _container_running(name: str) -> bool:
    try:
        r = subprocess.run(
            ["docker", "inspect", name, "--format", "{{.State.Status}}"],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode == 0 and r.stdout.strip() == "running"
    except Exception:
        return False


def is_applied() -> bool:
    return _container_running("aibox-sandbox")


def run() -> dict:
    if is_applied():
        return {"skipped": True, "reason": "aibox-sandbox already running"}

    # 1. Détecte runtime disponible (gVisor préféré, runc fallback)
    has_runsc = shutil.which("runsc") is not None
    runtime = "runsc" if has_runsc else "runc"
    _write_env_var("SANDBOX_RUNTIME", runtime)

    # 2. up le compose sandbox
    compose_dir = "/srv/ai-stack/services/sandbox"
    if not Path(compose_dir).exists():
        return {"ok": False, "reason": f"compose dir missing: {compose_dir}"}

    try:
        r = subprocess.run(
            ["docker", "compose",
             "--env-file", str(ENV_PATH),
             "-f", f"{compose_dir}/docker-compose.yml",
             "up", "-d", "--build", "--force-recreate"],
            capture_output=True, text=True, timeout=300, cwd=compose_dir,
        )
        if r.returncode != 0:
            return {
                "ok": False,
                "step": "compose_up",
                "rc": r.returncode,
                "stderr_tail": (r.stderr or "")[-400:],
                "runtime": runtime,
            }
    except Exception as e:
        return {"ok": False, "step": "compose_up", "error": str(e)[:200]}

    # 3. Vérifie que ça tourne
    running = _container_running("aibox-sandbox")
    return {
        "ok": running,
        "runtime": runtime,
        "gvisor_available": has_runsc,
        "container_running": running,
        "security_note": "DÉGRADÉE (runc)" if runtime == "runc" else "OK (gVisor isolation)",
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
