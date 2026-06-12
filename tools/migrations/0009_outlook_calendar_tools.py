"""Migration 0009 — Custom Tool « BoxIA Outlook + Calendar Tools ».

Provisionne dans Dify le tool qui expose 5 endpoints :
  - outlook_read_inbox
  - outlook_search
  - outlook_get_message
  - calendar_today
  - calendar_find_free_slot

Puis attache aux 3 agents pertinents :
  - Assistant général (le défaut)
  - Concierge BoxIA
  - Assistant tri emails (déjà ouvert sur Gmail Tools, on étend)

Idempotent. Pattern miroir de la migration 0007 (Gmail).
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

DESCRIPTION = "Outlook + Calendar Custom Tool Dify + attach 3 agents"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
AGENTS_API_KEY = os.environ.get("AGENTS_API_KEY", "")

PROVIDER_NAME = "BoxIA Outlook Calendar Tools"
TARGET_AGENT_NAMES = ["Assistant général", "Concierge BoxIA", "Assistant tri emails"]
EXPECTED_TOOL_OPS = [
    "outlook_read_inbox",
    "outlook_search",
    "outlook_get_message",
    "calendar_today",
    "calendar_find_free_slot",
]

_YAML_CANDIDATES = [
    "/srv/ai-stack/templates/dify/connector-outlook-calendar-openapi.yaml",
    str(Path(__file__).resolve().parent.parent.parent
        / "templates" / "dify" / "connector-outlook-calendar-openapi.yaml"),
]


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


def _load_yaml() -> str:
    for p in _YAML_CANDIDATES:
        if os.path.isfile(p):
            return open(p, encoding="utf-8").read()
    raise RuntimeError(f"YAML OpenAPI introuvable : {_YAML_CANDIDATES}")


def _find_provider(s):
    encoded = urllib.parse.quote(PROVIDER_NAME)
    try:
        r = s.get(f"/workspaces/current/tool-provider/api/get?provider={encoded}")
        return r if r else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _provider_id(s):
    # None si absent — ne JAMAIS retomber sur le nom : une ref
    # provider_id=<nom> dans agent_mode casse tous les chats de l'app en
    # 500 (incident 2026-06-12, nettoyé par la migration 0013).
    try:
        r = s.get("/workspaces/current/tool-providers")
        items = r if isinstance(r, list) else (r.get("data") or [])
        for p in items:
            if isinstance(p, dict) and (p.get("name") == PROVIDER_NAME
                                        or p.get("provider") == PROVIDER_NAME):
                return p.get("id")
    except Exception:
        pass
    return None


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def _attached(model_config: dict) -> set:
    agent_mode = (model_config or {}).get("agent_mode") or {}
    tools = agent_mode.get("tools") or []
    return {t.get("tool_name") for t in tools
            if t.get("provider_name") == PROVIDER_NAME}


def is_applied() -> bool:
    if not AGENTS_API_KEY:
        return False
    try:
        s = _connect()
    except Exception:
        return False
    if not _find_provider(s):
        return False
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            continue  # tolerate absence (peut être pas encore provisionné)
        cfg = s.get(f"/apps/{app['id']}")
        if not all(op in _attached(cfg.get("model_config") or {}) for op in EXPECTED_TOOL_OPS):
            return False
    return True


def run() -> None:
    if not AGENTS_API_KEY:
        raise RuntimeError("AGENTS_API_KEY non défini")
    s = _connect()
    schema = _load_yaml()
    existing = _find_provider(s)
    payload = {
        "provider": PROVIDER_NAME,
        "original_provider": (existing.get("original_provider")
                              or existing.get("provider")
                              or PROVIDER_NAME) if existing else PROVIDER_NAME,
        "icon": {"background": "#DBEAFE", "content": "📅"},
        "credentials": {
            "auth_type": "api_key",
            "api_key_header": "Authorization",
            "api_key_value": f"Bearer {AGENTS_API_KEY}",
            "api_key_header_prefix": "no_prefix",
        },
        "schema_type": "openapi",
        "schema": schema,
        "privacy_policy": "",
        "custom_disclaimer":
            "Outils Outlook + Calendar BoxIA. Lecture seule via OAuth utilisateur "
            "(Connecteurs → Outlook / Google Calendar / Outlook Calendar).",
        "labels": ["outlook", "calendar", "connector", "boxia"],
    }
    if existing:
        ep = "/workspaces/current/tool-provider/api/update"
        action = "update"
    else:
        ep = "/workspaces/current/tool-provider/api/add"
        action = "create"
    print(f"  {action} provider {PROVIDER_NAME}")
    s.post(ep, payload)

    prov_id = _provider_id(s)
    if not prov_id:
        raise RuntimeError(
            f"Provider '{PROVIDER_NAME}' introuvable après le {action} — "
            "attach annulé pour ne pas écrire de ref orpheline.")
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            print(f"  ⚠ App '{name}' absente — skip")
            continue
        cfg_full = s.get(f"/apps/{app['id']}")
        model_config = cfg_full.get("model_config") or {}
        attached_ops = _attached(model_config)
        if all(op in attached_ops for op in EXPECTED_TOOL_OPS):
            print(f"  - {name}: déjà attaché")
            continue
        agent_mode = model_config.get("agent_mode") or {}
        existing_tools = list(agent_mode.get("tools") or [])
        new_tools = list(existing_tools)
        for op in EXPECTED_TOOL_OPS:
            if op in attached_ops:
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
        for k in ("id", "app_id", "provider", "created_at", "updated_at"):
            model_config.pop(k, None)
        s.post(f"/apps/{app['id']}/model-config", model_config)
        print(f"  ✓ {name}: {len(new_tools) - len(existing_tools)} tools attachés")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
