"""Migration 0020 — applique les healthchecks pending sur tts + ollama.

Bug constaté 2026-05-07 fresh install : `tools/deploy-to-xefia.sh` ne
recreate que `services/app/` (cf hook block-direct-xefia-ops.sh). Donc
quand on patche les composes secondaires (tts, inference, sandbox), le
container live garde son ancien healthcheck → faux positifs unhealthy
(tts) ou aucune détection (ollama CPU pur silencieux).

Cette migration :
1. Detect si tts tourne avec un healthcheck `curl` (ancien) → recreate
   pour appliquer mon healthcheck `python urllib` (commit 1796f11)
2. Detect si ollama n'a pas de healthcheck → recreate pour appliquer
   mon healthcheck `ollama list + /proc/driver/nvidia/version` (commit 863f670)

Idempotent : `is_applied()` True si les 2 healthchecks live matchent
les YAMLs du repo.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

DESCRIPTION = "Recreate tts + ollama pour appliquer healthchecks pending"

ENV_PATH = Path(os.environ.get("AIBOX_ENV", "/srv/ai-stack/.env"))


def _container_healthcheck(name: str) -> str:
    """Retourne la commande healthcheck du container, ou '' si absente."""
    try:
        r = subprocess.run(
            ["docker", "inspect", name,
             "--format", "{{if .Config.Healthcheck}}{{range .Config.Healthcheck.Test}}{{.}} {{end}}{{end}}"],
            capture_output=True, text=True, timeout=10,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def _tts_healthcheck_modern(hc: str) -> bool:
    """Mon healthcheck nouveau utilise python3 urllib, pas curl.

    Note : l'image opentts a python3 mais pas python (constaté 2026-05-07).
    On veut python3 explicite ; un healthcheck `python` (sans 3) est faux
    et doit être recréé.
    """
    return "python3" in hc and "urllib" in hc


def _ollama_healthcheck_set(hc: str) -> bool:
    """Mon healthcheck nouveau utilise ollama list + /proc/driver/nvidia."""
    return "ollama list" in hc and "/proc/driver/nvidia" in hc


def is_applied() -> bool:
    tts_hc = _container_healthcheck("aibox-tts")
    ollama_hc = _container_healthcheck("ollama")
    # Si les containers n'existent pas → considéré applied (rien à faire ici).
    if not tts_hc and not ollama_hc:
        return True
    return _tts_healthcheck_modern(tts_hc) and _ollama_healthcheck_set(ollama_hc)


def _ensure_ollama_volume_name() -> str | None:
    """Detect le volume Ollama existant et patch .env si absent.

    Bug 2026-05-07 : le .env xefia n'a pas `OLLAMA_VOLUME_NAME`, le compose
    fallback sur `anythingllm_ollama_data` (default) qui n'existe pas →
    'external volume not found'. Le volume reel est `stack_xefia_ollama_data`
    (heritage rebrand AnythingLLM → BoxIA mai 2026). Detect et fix .env.
    """
    # Check si OLLAMA_VOLUME_NAME deja dans .env
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            if line.startswith("OLLAMA_VOLUME_NAME=") and not line.startswith("#"):
                value = line.split("=", 1)[1].strip("'\"")
                if value:
                    return value

    # Pas dans .env → liste les volumes Docker et match
    try:
        r = subprocess.run(
            ["docker", "volume", "ls", "--format", "{{.Name}}"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return None
        volumes = r.stdout.strip().splitlines()
        candidates = [v for v in volumes if "ollama" in v.lower() and "data" in v.lower()]
        if not candidates:
            candidates = [v for v in volumes if "ollama" in v.lower()]
        if not candidates:
            return None
        # Prend le premier (heuristique : un seul volume ollama_data attendu)
        chosen = candidates[0]
        # Append au .env
        with ENV_PATH.open("a") as f:
            f.write(f"\nOLLAMA_VOLUME_NAME={chosen}\n")
        return chosen
    except Exception:
        return None


def _compose_up(compose_path: str) -> tuple[bool, str]:
    """`docker compose --env-file ... up -d --force-recreate`."""
    compose_dir = str(Path(compose_path).parent)
    r = subprocess.run(
        ["docker", "compose",
         "--env-file", str(ENV_PATH),
         "-f", compose_path,
         "up", "-d", "--force-recreate"],
        capture_output=True, text=True, timeout=180, cwd=compose_dir,
    )
    return r.returncode == 0, r.stderr or ""


def _recreate_compose(compose_path: str, container_name: str) -> dict:
    """Tente compose up -d --force-recreate.

    Si échec 'name already in use' (le container existe sans le label
    compose project — typique d'un container lancé manuellement avant
    que compose ne reprenne la main), on `docker rm -f` puis on retry.
    """
    if not Path(compose_path).exists():
        return {"ok": False, "reason": f"compose missing: {compose_path}"}

    ok, stderr = _compose_up(compose_path)
    fallback_used = False
    if not ok and ("already in use" in stderr or "is already in use" in stderr):
        # Container existe sans le bon label compose → kill et retry
        try:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                capture_output=True, timeout=15,
            )
            fallback_used = True
            ok, stderr = _compose_up(compose_path)
        except Exception as e:
            return {"ok": False, "error": str(e)[:200], "container": container_name}

    return {
        "ok": ok,
        "stderr_tail": stderr[-200:],
        "container": container_name,
        "fallback_rm_used": fallback_used,
    }


def run() -> dict:
    if is_applied():
        return {"skipped": True, "reason": "healthchecks already in sync"}

    results: dict = {}

    # 1. tts si curl encore présent
    tts_hc = _container_healthcheck("aibox-tts")
    if tts_hc and not _tts_healthcheck_modern(tts_hc):
        results["tts"] = _recreate_compose(
            "/srv/ai-stack/services/tts/docker-compose.yml", "aibox-tts",
        )

    # 2. ollama si healthcheck absent
    ollama_hc = _container_healthcheck("ollama")
    if not _ollama_healthcheck_set(ollama_hc):
        # Pre-requis : OLLAMA_VOLUME_NAME doit pointer sur un volume existant
        # (sinon compose echoue 'external volume not found').
        vol = _ensure_ollama_volume_name()
        ollama_res = _recreate_compose(
            "/srv/ai-stack/services/inference/docker-compose.yml", "ollama",
        )
        ollama_res["volume_detected"] = vol or "FAILED"
        results["ollama"] = ollama_res

    all_ok = all(r.get("ok") for r in results.values()) if results else True
    return {"ok": all_ok, "results": results}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
