"""Migration 0016 — fix NEXTAUTH_URL=localhost → IP LAN détectée.

Contexte : bug fresh install xefia 2026-05-07. Le wizard a déterminé
NEXTAUTH_URL via le header HTTP `Host` de la requête au wizard. Si l'user
accède au wizard via SSH tunnel (http://localhost:8080) ou 127.0.0.1, le
.env est écrit avec NEXTAUTH_URL=http://localhost:3100. Login fonctionne
depuis le serveur mais cassé depuis tout browser LAN : redirect_uri OIDC
http://localhost:3100/... non joignable depuis la machine de l'utilisateur.

Fix code permanent : commit 34404f9 (fonction _detect_lan_ip dans le
wizard pour les futurs installs).
Fix runtime : cette migration patche les .env déjà déployés.

Idempotence :
  - is_applied() = True si NEXTAUTH_URL ne contient PAS "localhost"
  - run() :
      1. Détecte IP LAN (UDP socket 8.8.8.8 trick)
      2. sed -i sur /srv/ai-stack/.env (NEXTAUTH_URL + AUTHENTIK_APP_ISSUER)
      3. PATCH redirect_uris du provider Authentik OIDC aibox-app
      4. docker restart aibox-app (relit .env au start)

Sécurité : ne tourne que si NEXTAUTH_URL contient "localhost". Skip sinon.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

DESCRIPTION = "Fix NEXTAUTH_URL=localhost → IP LAN auto-détectée (login OIDC LAN)"

ENV_PATH = Path(os.environ.get("AIBOX_ENV", "/srv/ai-stack/.env"))


def _detect_lan_ip() -> str:
    """Détecte l'IP LAN du host. Voir services/setup/app/main.py."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def _read_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k] = v.strip("'\"")
    return out


def is_applied() -> bool:
    env = _read_env()
    nau = env.get("NEXTAUTH_URL", "")
    aki = env.get("AUTHENTIK_APP_ISSUER", "")
    # Considéré appliqué si aucune des deux URLs ne pointe vers localhost.
    return "localhost" not in nau and "localhost" not in aki


def _patch_env_file(lan_ip: str) -> tuple[str, str]:
    """Réécrit .env en remplaçant localhost par l'IP LAN dans 2 vars.

    Retourne (old_url_app, new_url_app) pour info.
    """
    txt = ENV_PATH.read_text()
    old_app = f"http://localhost:3100"
    new_app = f"http://{lan_ip}:3100"
    old_auth = f"http://localhost:9000"
    new_auth = f"http://{lan_ip}:9000"
    new = (
        txt.replace(f"NEXTAUTH_URL={old_app}", f"NEXTAUTH_URL={new_app}")
           .replace(f"AUTHENTIK_APP_ISSUER={old_auth}", f"AUTHENTIK_APP_ISSUER={new_auth}")
    )
    if new != txt:
        ENV_PATH.write_text(new)
    return old_app, new_app


def _patch_authentik_redirect_uri(env: dict[str, str], new_callback: str) -> dict:
    """Ajoute le redirect_uri LAN au provider Authentik aibox-app.

    Authentik API : GET /api/v3/providers/oauth2/?slug=aibox-app puis
    PATCH avec la liste mise à jour. Ne supprime aucun redirect_uri
    existant (les deux URIs cohabitent : localhost + IP LAN).
    """
    base = "http://localhost:9000"
    token = env.get("AUTHENTIK_API_TOKEN", "")
    if not token:
        return {"ok": False, "reason": "no AUTHENTIK_API_TOKEN"}
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        # Trouve le provider aibox-app
        req = urllib.request.Request(
            f"{base}/api/v3/providers/oauth2/?ordering=name",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        provider = next(
            (p for p in data.get("results", []) if p.get("client_id") == "aibox-app"),
            None,
        )
        if not provider:
            return {"ok": False, "reason": "provider aibox-app not found"}
        pid = provider["pk"]
        existing = provider.get("redirect_uris", []) or []
        # Authentik ≥2024 stocke redirect_uris comme liste de dict
        # {matching_mode: 'strict', url: '...'}. Avant, c'était une string
        # multiligne. On gère les 2 formats.
        if isinstance(existing, str):
            uris = [u for u in existing.splitlines() if u.strip()]
            if new_callback not in uris:
                uris.append(new_callback)
            payload = {"redirect_uris": "\n".join(uris)}
        else:
            urls = {u.get("url") for u in existing if isinstance(u, dict)}
            if new_callback in urls:
                return {"ok": True, "already": True}
            new_list = list(existing) + [{"matching_mode": "strict", "url": new_callback}]
            payload = {"redirect_uris": new_list}
        req = urllib.request.Request(
            f"{base}/api/v3/providers/oauth2/{pid}/",
            data=json.dumps(payload).encode(),
            headers=headers,
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return {"ok": True, "added": new_callback, "status": r.status}
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_error": e.code, "body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _restart_aibox_app() -> bool:
    """docker restart aibox-app pour relire le nouveau .env."""
    try:
        r = subprocess.run(
            ["docker", "restart", "aibox-app"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode == 0
    except Exception:
        return False


def run() -> dict:
    if is_applied():
        return {"skipped": True, "reason": "already not localhost"}
    env = _read_env()
    lan_ip = _detect_lan_ip()
    if lan_ip in ("127.0.0.1", "0.0.0.0", ""):
        return {"ok": False, "reason": f"could not detect LAN IP (got '{lan_ip}')"}
    old_url, new_url = _patch_env_file(lan_ip)
    new_callback = f"http://{lan_ip}:3100/api/auth/callback/authentik"
    ak_result = _patch_authentik_redirect_uri(env, new_callback)
    restart_ok = _restart_aibox_app()
    return {
        "ok": True,
        "lan_ip": lan_ip,
        "env_patched": old_url + " → " + new_url,
        "authentik_patch": ak_result,
        "aibox_app_restarted": restart_ok,
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
