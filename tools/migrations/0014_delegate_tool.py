"""Migration 0014 — provisionne le Custom Tool « BoxIA Delegate To Specialist »
dans Dify et l'attache au Concierge.

Le YAML OpenAPI est dans templates/dify/delegate-to-specialist-openapi.yaml.
Il expose 1 endpoint (delegate_to_specialist) côté aibox-app /api/agents-tools/,
auth Bearer AGENTS_API_KEY. L'endpoint permet au Concierge de déléguer
en blocking à un agent spécialisé (general/vision/accountant/hr/support).

Sans cette migration, le Concierge connait le tool dans son pre_prompt
(via migration 0013 [DELEGATE-V1]) mais ne peut pas l'appeler concrètement.

Idempotente :
  - Si le provider existe déjà → POST update (pas add)
  - Si le tool est déjà attaché → no-op
  - Si le Concierge n'existe pas → skip (ne bloque pas la chaîne)

Auth Dify : cookies + X-CSRF-TOKEN, pattern hérité de 0010.

Référence : tools/research/audit_P0_04_delegate.md + DECISIONS-P0.md §D5
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

DESCRIPTION = "Provisionne BoxIA Delegate To Specialist tool + attach au Concierge"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
AGENTS_API_KEY = os.environ.get("AGENTS_API_KEY", "")

PROVIDER_NAME = "boxia-delegate"
TARGET_AGENT_NAMES = [
    "Concierge BoxIA",
]
EXPECTED_TOOL_OPS = ["delegate_to_specialist"]

_YAML_CANDIDATES = [
    "/srv/ai-stack/templates/dify/delegate-to-specialist-openapi.yaml",
    str(Path(__file__).resolve().parent.parent.parent
        / "templates" / "dify" / "delegate-to-specialist-openapi.yaml"),
]


# ---------------------------------------------------------------------------
# Auth Dify (cookies + CSRF) — pattern partagé avec 0010
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
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token:
            h["X-CSRF-TOKEN"] = self.csrf_token
        if extra:
            h.update(extra)
        return h

    def login(self, email, password):
        if not email or not password:
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant")
        body = json.dumps({
            "email": email, "password": password,
            "language": "fr-FR", "remember_me": True,
        }).encode()
        req = urllib.request.Request(
            f"{self.base}/login",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with self.opener.open(req, timeout=15) as r:
            r.read()
        for c in self.cj:
            if c.name == "access_token":
                self.access_token = c.value
            elif c.name == "csrf_token":
                self.csrf_token = c.value
        if not self.access_token:
            raise RuntimeError("Login Dify : pas d'access_token")

    def get(self, path):
        req = urllib.request.Request(
            f"{self.base}{path}",
            headers=self._headers(),
            method="GET",
        )
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
        if os.path.exists(p):
            return open(p, encoding="utf-8").read()
    raise RuntimeError(
        f"YAML OpenAPI delegate introuvable dans {_YAML_CANDIDATES}",
    )


def _provider_credentials():
    return {
        "auth_type": "api_key",
        "api_key_header": "Authorization",
        "api_key_value": f"Bearer {AGENTS_API_KEY}",
        "api_key_header_prefix": "no_prefix",
    }


def _find_provider(s):
    try:
        encoded = urllib.parse.quote(PROVIDER_NAME)
        r = s.get(f"/workspaces/current/tool-provider/api/get?provider={encoded}")
        if r:
            return r
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            try:
                body = json.loads(e.read())
                if "you have not added" in (body.get("message") or "").lower():
                    return None
            except Exception:
                pass
            if e.code == 404:
                return None
        raise
    return None


def _list_tool_providers(s):
    try:
        r = s.get("/workspaces/current/tool-providers")
        if isinstance(r, list):
            return r
        return r.get("data") or []
    except Exception:
        return []


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def _is_attached(model_config: dict) -> bool:
    agent_mode = (model_config or {}).get("agent_mode") or {}
    tools = agent_mode.get("tools") or []
    attached = {t.get("tool_name") for t in tools
                if t.get("provider_name") == PROVIDER_NAME}
    return all(op in attached for op in EXPECTED_TOOL_OPS)


def _attach_to_app(s, app_name, prov_id) -> dict:
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

    # Strip read-only fields (Dify ≥1.10)
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    s.post(f"/apps/{app['id']}/model-config", model_config)
    return {"app": app_name, "status": "attached"}


def is_applied() -> bool:
    if not AGENTS_API_KEY:
        print("  is_applied: AGENTS_API_KEY manquant — assume not applied", file=sys.stderr)
        return False
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e})", file=sys.stderr)
        return False
    if not _find_provider(s):
        return False
    any_attached = False
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            continue
        cfg = s.get(f"/apps/{app['id']}")
        if _is_attached(cfg.get("model_config") or {}):
            any_attached = True
            break
    return any_attached


def run() -> None:
    if not AGENTS_API_KEY:
        raise RuntimeError("AGENTS_API_KEY non défini dans l'environnement")

    s = _connect()
    schema = _load_yaml()

    # 1. Provisionne le provider (create or update)
    existing = _find_provider(s)
    payload = {
        "provider": PROVIDER_NAME,
        "original_provider": PROVIDER_NAME,
        "icon": {"background": "#FEF3C7", "content": "🤝"},
        "credentials": _provider_credentials(),
        "schema_type": "openapi",
        "schema": schema,
        "privacy_policy": "",
        "custom_disclaimer":
            "Outil de délégation BoxIA. Permet à un agent IA d'appeler "
            "un autre agent spécialisé en blocking. Lecture seule, pas "
            "de mutation système. Profondeur max 2, timeout 60s.",
        "labels": ["delegate", "multi-agent", "boxia"],
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

    # 2. Récupère le provider_id réel pour l'attachement
    provider_id = PROVIDER_NAME
    for p in _list_tool_providers(s):
        if isinstance(p, dict) and (p.get("name") == PROVIDER_NAME
                                    or p.get("provider") == PROVIDER_NAME):
            provider_id = p.get("id") or PROVIDER_NAME
            break

    # 3. Attache au Concierge (best-effort)
    results = []
    for name in TARGET_AGENT_NAMES:
        try:
            r = _attach_to_app(s, name, provider_id)
            results.append(r)
            print(f"  - {r}")
        except Exception as e:
            results.append({"app": name, "status": "error", "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)

    success = sum(1 for r in results if r.get("status") in ("attached", "already_attached"))
    print(f"  ✓ Delegate provisionné — attaché à {success}/{len(TARGET_AGENT_NAMES)} agents")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
