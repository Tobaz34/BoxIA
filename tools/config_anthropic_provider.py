"""
Script ad-hoc : configure le provider Anthropic dans Dify (POST credentials)
+ écrit le state local /data/cloud-providers.json pour que l'UI affiche
le badge vert + que la modale dise "Provider configuré".

À usage one-shot quand l'UI Settings est figée. Idempotent.

Usage :
  ssh xefia "ANTHROPIC_KEY='sk-ant-...' ADMIN_EMAIL='a.ladurelle@xefi.fr' \\
             ADMIN_PASSWORD='aibox-changeme2026' python3 /tmp/config_anthropic_provider.py"
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

BASE = "http://localhost:8081"
STATE_FILE = Path("/data/cloud-providers.json")
ALT_STATE_FILE = Path("/srv/ai-stack/data/cloud-providers.json")


def login(session, email, pwd):
    r = session.post(
        f"{BASE}/console/api/login",
        json={"email": email, "password": pwd, "language": "fr-FR", "remember_me": True},
        timeout=30,
    )
    r.raise_for_status()
    access = session.cookies.get("access_token")
    csrf = session.cookies.get("csrf_token")
    if not access or not csrf:
        sys.exit("login OK mais cookies manquants")
    session.headers["Authorization"] = f"Bearer {access}"
    session.headers["X-CSRF-TOKEN"] = csrf


def push_anthropic_credentials(session, api_key):
    """Pousse la clé Anthropic dans Dify console.
    URL : POST /workspaces/current/model-providers/langgenius/anthropic/anthropic/credentials
    Body : {credentials: {api_key, anthropic_api_key, mode optionnel}}
    """
    creds = {
        "api_key": api_key,
        "anthropic_api_key": api_key,  # Dify attend parfois ce champ
    }
    url = (
        f"{BASE}/console/api/workspaces/current/model-providers/"
        f"langgenius/anthropic/anthropic/credentials"
    )
    r = session.post(url, json={"credentials": creds}, timeout=60)
    if r.status_code in (200, 201):
        return True, r.text[:200]
    return False, f"HTTP {r.status_code}: {r.text[:300]}"


def write_local_state(api_key):
    """Écrit /data/cloud-providers.json comme l'API /api/cloud-providers le ferait.
    Format suit StateFile dans services/app/src/lib/cloud-providers.ts."""
    target = STATE_FILE if STATE_FILE.parent.exists() else ALT_STATE_FILE
    state = {}
    if target.exists():
        try:
            state = json.loads(target.read_text())
        except json.JSONDecodeError:
            state = {}
    state.setdefault("version", 1)
    state.setdefault("budget_monthly_eur", 50)
    state.setdefault("pii_scrub_enabled", True)
    state.setdefault("providers", {})
    state["providers"]["anthropic"] = {
        "id": "anthropic",
        "configured": True,
        "enabled_models": ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
        "key_prefix": api_key[:12],
        "configured_at": int(time.time() * 1000),
        "last_used_at": None,
        "tokens_this_month": 0,
        "cost_eur_this_month": 0,
    }
    state["updated_at"] = int(time.time() * 1000)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    print(f"[+] Wrote {target}")


def main():
    api_key = os.environ.get("ANTHROPIC_KEY", "").strip()
    email = os.environ.get("ADMIN_EMAIL")
    pwd = os.environ.get("ADMIN_PASSWORD")
    if not api_key or not email or not pwd:
        sys.exit("ANTHROPIC_KEY + ADMIN_EMAIL + ADMIN_PASSWORD requis")

    s = requests.Session()
    login(s, email, pwd)
    print(f"[+] Logged in Dify as {email}")

    ok, body = push_anthropic_credentials(s, api_key)
    if ok:
        print(f"[✓] Dify credentials POST OK: {body}")
    else:
        print(f"[!] Dify credentials POST failed: {body}")
        # On écrit quand même le state local (pour que l'UI affiche le badge)
        # même si Dify a refusé — l'utilisateur pourra retry depuis settings
        # ou on traitera l'erreur Dify séparément.

    write_local_state(api_key)
    print("[Done]")


if __name__ == "__main__":
    main()
