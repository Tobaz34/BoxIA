"""Migration 0012 — passe agent_mode.strategy de `react` à `function_call`
pour les agents qui ont rag_search ou un tool BoxIA attaché.

Constat 2026-05-05 : malgré pre_prompt explicite [RAG-SEARCH-V1] et
tool rag_search bien attaché, qwen3:14b ne sait pas exploiter les
chunks retournés. Diagnostic :
  - mode `agent-chat` ✅
  - strategy `react` ❌ (legacy, format Thought/Action/Observation
    fragile en français avec un long pre_prompt)

Or qwen3:14b a un function calling NATIF (cf memory
sprint_v11_audits.md) et Dify supporte `function_call` strategy qui
est plus simple : le LLM call directement la fonction, Dify gère le
serialize/deserialize, le modèle reçoit le résultat comme tool
message et génère la réponse.

Bénéfice attendu : moins de hallucinations, meilleur taux de tool
invocation, exploitation correcte des chunks renvoyés.

Cibles : tous les agents qui ont au moins 1 tool BoxIA attaché
(provider_name commence par "BoxIA " ou == "boxia-rag-search").

Idempotent : check `strategy == "function_call"` avant d'écrire.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request

DESCRIPTION = "Passe agent_mode.strategy de react à function_call (qwen3 native FC)"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")


# ---------------------------------------------------------------------------
# Auth Dify (cookies + CSRF)
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


def _list_apps(s) -> list[dict]:
    try:
        r = s.get("/apps?page=1&limit=100")
        return r.get("data") or []
    except Exception:
        return []


def _has_boxia_tool(model_config: dict) -> bool:
    """L'agent a-t-il au moins 1 tool BoxIA attaché ? On cherche les
    provider_name qui commencent par 'BoxIA ' ou == 'boxia-rag-search'."""
    tools = ((model_config or {}).get("agent_mode") or {}).get("tools") or []
    for t in tools:
        pn = t.get("provider_name") or ""
        if pn.startswith("BoxIA ") or pn == "boxia-rag-search":
            return True
    return False


def _patch_app(s, app: dict) -> dict:
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}
    agent_mode = model_config.get("agent_mode") or {}

    if not _has_boxia_tool(model_config):
        return {"app": app["name"], "status": "skipped_no_boxia_tool"}

    current_strategy = agent_mode.get("strategy")
    if current_strategy == "function_call":
        return {"app": app["name"], "status": "already_function_call"}

    agent_mode["strategy"] = "function_call"
    model_config["agent_mode"] = agent_mode

    # Strip read-only fields
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    s.post(f"/apps/{app['id']}/model-config", model_config)
    return {
        "app": app["name"],
        "status": "patched",
        "before_strategy": current_strategy,
        "after_strategy": "function_call",
    }


def is_applied() -> bool:
    """Applied = tous les agents avec un tool BoxIA ont strategy
    function_call. Si au moins 1 a encore react → not applied."""
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e})", file=sys.stderr)
        return False
    for app in _list_apps(s):
        try:
            cfg = s.get(f"/apps/{app['id']}")
            mc = cfg.get("model_config") or {}
            if not _has_boxia_tool(mc):
                continue
            am = mc.get("agent_mode") or {}
            if am.get("strategy") != "function_call":
                return False
        except Exception:
            continue
    return True


def run() -> None:
    s = _connect()
    results = []
    for app in _list_apps(s):
        try:
            r = _patch_app(s, app)
            results.append(r)
            if r.get("status") == "patched":
                print(f"  ✓ {r['app']}: {r['before_strategy']} → function_call")
            elif r.get("status") not in ("skipped_no_boxia_tool",):
                print(f"  - {r}")
        except Exception as e:
            results.append({"app": app.get("name"), "status": "error", "error": str(e)})
            print(f"  ✗ {app.get('name')}: {e}", file=sys.stderr)

    patched = sum(1 for r in results if r.get("status") == "patched")
    skipped = sum(1 for r in results if r.get("status") == "skipped_no_boxia_tool")
    already = sum(1 for r in results if r.get("status") == "already_function_call")
    print(f"  Total : {patched} patché(s), {already} déjà OK, {skipped} skip (pas de tool BoxIA)")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
