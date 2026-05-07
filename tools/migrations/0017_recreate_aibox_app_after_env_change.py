"""Migration 0017 — force recreate aibox-app si env vars du container diffèrent du .env.

Contexte : la migration 0016 patche /srv/ai-stack/.env (NEXTAUTH_URL +
AUTHENTIK_APP_ISSUER) puis tente un `docker restart`. Mais `docker restart`
NE relit PAS les variables d'environnement — elles sont figées à la
création du container. Du coup le container live tourne encore avec les
anciennes valeurs (localhost) et le login OIDC reste cassé.

Ce fix : compare la valeur de NEXTAUTH_URL dans /srv/ai-stack/.env vs
celle dans `docker inspect aibox-app`. Si différentes, force recreate via
`docker compose --env-file ... up -d --force-recreate`.

Idempotent : si les valeurs match déjà, skip.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

DESCRIPTION = "Recreate aibox-app si NEXTAUTH_URL container ≠ .env (post-0016)"

ENV_PATH = Path(os.environ.get("AIBOX_ENV", "/srv/ai-stack/.env"))


def _env_value(key: str) -> str:
    if not ENV_PATH.exists():
        return ""
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith(f"{key}=") and not line.startswith("#"):
            return line.split("=", 1)[1].strip("'\"")
    return ""


def _container_env(container: str, key: str) -> str:
    try:
        r = subprocess.run(
            ["docker", "inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return ""
        for line in r.stdout.splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1]
        return ""
    except Exception:
        return ""


def is_applied() -> bool:
    """Appliqué si la valeur du container == valeur .env (ou container absent)."""
    env_url = _env_value("NEXTAUTH_URL")
    container_url = _container_env("aibox-app", "NEXTAUTH_URL")
    if not container_url:
        # Container pas tourné, rien à faire (sera re-créé proprement par compose up suivant)
        return True
    return env_url == container_url


def run() -> dict:
    if is_applied():
        return {"skipped": True, "reason": "container env matches .env"}

    compose_dir = "/srv/ai-stack/services/app"
    env_file = str(ENV_PATH)
    if not Path(compose_dir).exists():
        return {"ok": False, "reason": f"compose dir missing: {compose_dir}"}

    try:
        r = subprocess.run(
            [
                "docker", "compose",
                "--env-file", env_file,
                "-f", f"{compose_dir}/docker-compose.yml",
                "up", "-d", "--force-recreate", "--no-build",
            ],
            capture_output=True, text=True, timeout=180, cwd=compose_dir,
        )
        return {
            "ok": r.returncode == 0,
            "rc": r.returncode,
            "stderr_tail": (r.stderr or "")[-300:],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
