"""Migration 0007 — provisionne le Custom Tool « BoxIA Gmail Tools » dans
Dify et l'attache à l'agent « Assistant tri emails ».

Le YAML OpenAPI est dans templates/dify/connector-gmail-openapi.yaml. Il
expose 3 endpoints (gmail_read_inbox, gmail_search, gmail_get_thread)
côté aibox-app /api/agents-tools/, auth Bearer AGENTS_API_KEY. Les
endpoints lisent le token OAuth Google de l'utilisateur connecté via
/connectors UI (cf lib/oauth-storage.ts).

Idempotent : si le provider existe déjà dans Dify → POST update plutôt
que add. Si l'app "Assistant tri emails" est déjà en mode agent-chat
avec ces tools → no-op.

Auth Dify : cookies + X-CSRF-TOKEN (Dify ≥1.10), même pattern que la
migration 0001_dify_max_tokens.
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

DESCRIPTION = "Provisionne BoxIA Gmail Tools custom tool + attach à 'Assistant tri emails'"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
AGENTS_API_KEY = os.environ.get("AGENTS_API_KEY", "")

PROVIDER_NAME = "BoxIA Gmail Tools"
TARGET_AGENT_NAME = "Assistant tri emails"

# Recherche le YAML dans 2 endroits possibles selon l'environnement
_YAML_CANDIDATES = [
    "/srv/ai-stack/templates/dify/connector-gmail-openapi.yaml",
    str(Path(__file__).resolve().parent.parent.parent / "templates" / "dify" / "connector-gmail-openapi.yaml"),
]

# Tools que la migration s'attend à voir dans le YAML (utilisés pour
# l'attachement au model-config de l'agent en mode agent-chat).
EXPECTED_TOOL_OPS = ["gmail_read_inbox", "gmail_search", "gmail_get_thread"]


# ---------------------------------------------------------------------------
# Auth Dify (cookies + CSRF, cf migration 0001)
# ---------------------------------------------------------------------------

class _DifySession:
    def __init__(self, base: str):
        self.base = base
        self.cookiejar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookiejar)
        )
        self.access_token = None
        self.csrf_token = None

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token:
            h["X-CSRF-TOKEN"] = self.csrf_token
        if extra:
            h.update(extra)
        return h

    def _cookie(self, name):
        for c in self.cookiejar:
            if c.name == name:
                return c.value
        return None

    def login(self, email, password):
        if not email or not password:
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant dans l'environnement")
        payload = json.dumps({
            "email": email,
            "password": password,
            "language": "fr-FR",
            "remember_me": True,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/login",
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with self.opener.open(req, timeout=15) as r:
            body = json.loads(r.read())
        self.access_token = self._cookie("access_token") or (body.get("data") or {}).get("access_token")
        self.csrf_token = self._cookie("csrf_token")
        if not self.access_token:
            raise RuntimeError(f"Login Dify : pas d'access_token (cookies={[c.name for c in self.cookiejar]}, body={body})")

    def get(self, path):
        req = urllib.request.Request(f"{self.base}{path}", headers=self._headers(), method="GET")
        with self.opener.open(req, timeout=20) as r:
            return json.loads(r.read())

    def post(self, path, body):
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode("utf-8"),
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
    raise RuntimeError(f"YAML OpenAPI Gmail introuvable dans {_YAML_CANDIDATES}")


def _provider_credentials() -> dict:
    """Bearer AGENTS_API_KEY pour que Dify forward le header Authorization."""
    return {
        "auth_type": "api_key",
        "api_key_header": "Authorization",
        "api_key_value": f"Bearer {AGENTS_API_KEY}",
        "api_key_header_prefix": "no_prefix",
    }


def _find_provider(s: _DifySession) -> dict | None:
    """Retourne le record provider Gmail s'il existe, sinon None."""
    try:
        encoded = urllib.parse.quote(PROVIDER_NAME)
        r = s.get(f"/workspaces/current/tool-provider/api/get?provider={encoded}")
        if r:
            return r
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    return None


def _list_tool_providers(s: _DifySession) -> list[dict]:
    try:
        r = s.get("/workspaces/current/tool-providers")
        if isinstance(r, list):
            return r
        return r.get("data") or []
    except Exception:
        return []


def _find_app(s: _DifySession, name: str) -> dict | None:
    try:
        r = s.get(f"/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def is_applied() -> bool:
    """Vérifie si :
       - le provider Gmail existe dans Dify
       - ET (best-effort) ses 3 tools sont attachés au model-config de
         l'agent 'Assistant tri emails' (si l'agent existe).
    Sinon → run() refait le boulot.
    """
    if not AGENTS_API_KEY:
        print("  is_applied: AGENTS_API_KEY manquant — assume not applied", file=sys.stderr)
        return False
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e}) — assume not applied", file=sys.stderr)
        return False
    prov = _find_provider(s)
    if not prov:
        return False
    # Best-effort : check tools attachés à l'agent. Si l'agent n'existe
    # pas encore (provisioning incomplet), on considère provider seul = OK.
    app = _find_app(s, TARGET_AGENT_NAME)
    if not app:
        return True
    try:
        cfg = s.get(f"/apps/{app['id']}")
        agent_tools = (((cfg or {}).get("model_config") or {}).get("agent_mode") or {}).get("tools") or []
        attached_ops = {t.get("tool_name") for t in agent_tools if t.get("provider_name") == PROVIDER_NAME}
        return all(op in attached_ops for op in EXPECTED_TOOL_OPS)
    except Exception:
        return True


def run() -> None:
    if not AGENTS_API_KEY:
        raise RuntimeError("AGENTS_API_KEY non défini dans l'environnement xefia")
    s = _connect()
    schema = _load_yaml()

    # 1. Crée ou update le provider
    existing = _find_provider(s)
    payload = {
        "provider": PROVIDER_NAME,
        "original_provider": PROVIDER_NAME,
        "icon": {"background": "#FEE2E2", "content": "📧"},
        "credentials": _provider_credentials(),
        "schema_type": "openapi",
        "schema": schema,
        "privacy_policy": "",
        "custom_disclaimer":
            "Outils Gmail BoxIA. Lecture seule de la mailbox via OAuth utilisateur "
            "(Connecteurs → Gmail → Connecter avec Google).",
        "labels": ["gmail", "connector", "boxia"],
    }
    if existing:
        payload["original_provider"] = (
            existing.get("original_provider") or existing.get("provider") or PROVIDER_NAME
        )
        ep = "/workspaces/current/tool-provider/api/update"
        action = "update"
    else:
        ep = "/workspaces/current/tool-provider/api/add"
        action = "create"
    print(f"  {action} provider {PROVIDER_NAME} via {ep}")
    s.post(ep, payload)

    # 2. Attache les tools à l'agent "Assistant tri emails" (best-effort)
    app = _find_app(s, TARGET_AGENT_NAME)
    if not app:
        print(f"  ⚠ App '{TARGET_AGENT_NAME}' non trouvée — provider créé mais pas attaché.")
        return
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}
    # Ne pas casser les tools existants (ex: si concierge tools déjà attachés)
    agent_mode = model_config.get("agent_mode") or {}
    existing_tools = agent_mode.get("tools") or []

    # Récupère le provider_id réel
    provider_id = PROVIDER_NAME
    for p in _list_tool_providers(s):
        if isinstance(p, dict) and (p.get("name") == PROVIDER_NAME or p.get("provider") == PROVIDER_NAME):
            provider_id = p.get("id") or PROVIDER_NAME
            break

    new_tools = list(existing_tools)
    attached_ops = {t.get("tool_name") for t in new_tools if t.get("provider_name") == PROVIDER_NAME}
    for op in EXPECTED_TOOL_OPS:
        if op in attached_ops:
            continue
        new_tools.append({
            "provider_id": provider_id,
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

    # Strip champs read-only
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    print(f"  attach {len(EXPECTED_TOOL_OPS)} tools à app {TARGET_AGENT_NAME} (id={app['id']})")
    s.post(f"/apps/{app['id']}/model-config", model_config)
    print("  ✓ Gmail Tools provisionné et attaché.")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
