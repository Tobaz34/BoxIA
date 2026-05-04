"""Migration 0008 — étend l'attachement du tool « BoxIA Gmail Tools » à
l'Assistant général et au Concierge BoxIA.

La migration 0007 a provisionné le tool dans Dify et l'a attaché à
l'agent « Assistant tri emails » uniquement. Constat user : quand on
demande « combien d'emails ai-je dans ma boîte gmail ? » à l'Assistant
général, il répond « je ne peux pas accéder à votre boîte » faute d'avoir
le tool.

Cette migration ajoute l'attachement à 2 agents supplémentaires :
  - Assistant général (l'agent par défaut quand on ouvre /discuter)
  - Concierge BoxIA (l'orchestrateur, déjà en mode agent-chat avec
    d'autres tools — on append nos 3 tools Gmail à sa liste existante)

Idempotente : si tools déjà attachés → no-op.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DESCRIPTION = "Attache Gmail Tools à Assistant général + Concierge BoxIA"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")

PROVIDER_NAME = "BoxIA Gmail Tools"
TARGET_AGENT_NAMES = ["Assistant général", "Concierge BoxIA"]
EXPECTED_TOOL_OPS = ["gmail_read_inbox", "gmail_search", "gmail_get_thread"]


# ---------------------------------------------------------------------------
# Auth Dify (cf 0001 / 0007)
# ---------------------------------------------------------------------------

class _DifySession:
    def __init__(self, base):
        self.base = base
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj),
        )
        self.access_token = None
        self.csrf_token = None

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.access_token: h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token: h["X-CSRF-TOKEN"] = self.csrf_token
        if extra: h.update(extra)
        return h

    def login(self, email, password):
        if not email or not password:
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant")
        body = json.dumps({"email": email, "password": password,
                           "language": "fr-FR", "remember_me": True}).encode()
        req = urllib.request.Request(f"{self.base}/login", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Accept": "application/json"},
                                     method="POST")
        with self.opener.open(req, timeout=15) as r:
            r.read()
        for c in self.cj:
            if c.name == "access_token": self.access_token = c.value
            elif c.name == "csrf_token": self.csrf_token = c.value
        if not self.access_token:
            raise RuntimeError("Login Dify : pas d'access_token")

    def get(self, path):
        req = urllib.request.Request(f"{self.base}{path}",
                                     headers=self._headers(), method="GET")
        with self.opener.open(req, timeout=20) as r:
            return json.loads(r.read())

    def post(self, path, body):
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode(),
            headers=self._headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with self.opener.open(req, timeout=30) as r:
            raw = r.read()
            try:
                return json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return {"raw": raw.decode("utf-8", errors="replace")}


def _connect():
    s = _DifySession(DIFY_API_URL)
    s.login(DIFY_ADMIN_EMAIL, DIFY_ADMIN_PASSWORD)
    return s


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception as e:
        print(f"  ⚠ list apps failed: {e}", file=sys.stderr)
    return None


def _provider_id(s):
    """Cherche l'id du provider Gmail dans /tool-providers (utilisé pour
    construire les entrées agent_mode.tools)."""
    try:
        r = s.get("/workspaces/current/tool-providers")
        items = r if isinstance(r, list) else (r.get("data") or [])
        for p in items:
            if isinstance(p, dict) and (p.get("name") == PROVIDER_NAME
                                        or p.get("provider") == PROVIDER_NAME):
                return p.get("id") or PROVIDER_NAME
    except Exception:
        pass
    return PROVIDER_NAME


def _is_attached(model_config: dict) -> bool:
    agent_mode = (model_config or {}).get("agent_mode") or {}
    tools = agent_mode.get("tools") or []
    attached = {t.get("tool_name") for t in tools
                if t.get("provider_name") == PROVIDER_NAME}
    return all(op in attached for op in EXPECTED_TOOL_OPS)


def _attach_to_app(s, app_name: str, prov_id: str) -> dict:
    app = _find_app(s, app_name)
    if not app:
        return {"app": app_name, "status": "not_found"}
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}
    if _is_attached(model_config):
        return {"app": app_name, "status": "already_attached"}

    agent_mode = model_config.get("agent_mode") or {}
    existing_tools = list(agent_mode.get("tools") or [])
    attached = {t.get("tool_name") for t in existing_tools
                if t.get("provider_name") == PROVIDER_NAME}
    new_tools = list(existing_tools)
    for op in EXPECTED_TOOL_OPS:
        if op in attached:
            continue
        new_tools.append({
            "provider_id": prov_id,
            "provider_name": PROVIDER_NAME,
            "provider_type": "api",
            "tool_name": op,
            "tool_label": op,
            "tool_parameters": {},
            "enabled": True,
        })
    agent_mode["enabled"] = True
    agent_mode["strategy"] = agent_mode.get("strategy") or "function_call"
    agent_mode["tools"] = new_tools
    model_config["agent_mode"] = agent_mode

    # Strip read-only fields (Dify ≥1.10 reject if present in POST)
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    s.post(f"/apps/{app['id']}/model-config", model_config)
    return {"app": app_name, "status": "attached", "tools_added": len(new_tools) - len(existing_tools)}


def is_applied() -> bool:
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login échec ({e})", file=sys.stderr)
        return False
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            # App pas encore provisionnée → on attend la prochaine run
            return False
        cfg = s.get(f"/apps/{app['id']}")
        if not _is_attached(cfg.get("model_config") or {}):
            return False
    return True


def run() -> None:
    s = _connect()
    prov_id = _provider_id(s)
    results = []
    for name in TARGET_AGENT_NAMES:
        try:
            r = _attach_to_app(s, name, prov_id)
            results.append(r)
            print(f"  - {r}")
        except Exception as e:
            results.append({"app": name, "status": "error", "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)
    success = sum(1 for r in results if r.get("status") in ("attached", "already_attached"))
    if success < len(TARGET_AGENT_NAMES):
        # Permet une fail partielle sans bloquer la chaîne migrations
        print(f"  ⚠ Attachement partiel : {success}/{len(TARGET_AGENT_NAMES)}")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
