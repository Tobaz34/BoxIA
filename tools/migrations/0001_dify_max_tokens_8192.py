"""Migration 0001 — force max_tokens=8192 sur toutes les apps Dify existantes.

Contexte : le provisioning historique créait les apps Dify avec max_tokens=2048,
trop bas pour qwen3:14b qui peut produire des réponses tronquées (BUG-013, fixé
par commit 5acb832 dans services/setup/app/sso_provisioning.py pour les
nouvelles installations). Cette migration applique la même correction aux
installations déjà déployées.

Idempotence : on PATCH la model_config de chaque app vers 8192 ; si déjà 8192,
le PATCH est sans effet (Dify accepte la même valeur sans erreur).

Auth : Dify ≥1.10 ne renvoie plus le token dans le body de /login — il pose
des cookies httpOnly (access_token, csrf_token) et exige les 2 headers
Authorization: Bearer + X-CSRF-TOKEN sur tous les appels console (cf
patch_vision_model.py BUG-022 pour le détail).
"""
from __future__ import annotations

import os
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Force max_tokens=8192 sur toutes les apps Dify (BUG-013)"

# URL par défaut : depuis le host xefia, on passe par le nginx Dify mappé sur 8081.
# Override possible via DIFY_CONSOLE_API (ex: http://aibox-dify-api:5001/console/api
# si on lance depuis un container du réseau aibox-net).
DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
TARGET_MAX_TOKENS = 8192

# vision_support: certains models exigent string "true" (validation Dify
# rejette bool true avec "Variable vision_support should be string"), cf
# patch_vision_model.py.


class _DifySession:
    """Session HTTP authentifiée Dify console (cookies + CSRF)."""

    def __init__(self, base: str):
        self.base = base
        self.cookiejar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookiejar)
        )
        self.access_token: str | None = None
        self.csrf_token: str | None = None

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token:
            h["X-CSRF-TOKEN"] = self.csrf_token
        if extra:
            h.update(extra)
        return h

    def _cookie(self, name: str) -> str | None:
        for c in self.cookiejar:
            if c.name == name:
                return c.value
        return None

    def login(self, email: str, password: str) -> None:
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
        # Dify ≥1.10 renvoie {"result": "success"} et pose les tokens en cookies.
        # Compat ancien Dify : si access_token est dans le body, on l'utilise aussi.
        self.access_token = self._cookie("access_token") or (body.get("data") or {}).get("access_token") or body.get("access_token")
        self.csrf_token = self._cookie("csrf_token")
        if not self.access_token:
            raise RuntimeError(f"Login Dify : pas d'access_token (cookies={[c.name for c in self.cookiejar]}, body={body})")
        # csrf_token absent = OK pour ancien Dify, fail seulement si POST échoue plus tard

    def get(self, path: str) -> Any:
        req = urllib.request.Request(f"{self.base}{path}", headers=self._headers(), method="GET")
        with self.opener.open(req, timeout=15) as r:
            return json.loads(r.read())

    def post(self, path: str, body: dict) -> Any:
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with self.opener.open(req, timeout=30) as r:
            raw = r.read()
            if not raw:
                return None
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw


def _connect() -> _DifySession:
    s = _DifySession(DIFY_API_URL)
    s.login(DIFY_ADMIN_EMAIL, DIFY_ADMIN_PASSWORD)
    return s


def _list_apps(s: _DifySession) -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        data = s.get(f"/apps?page={page}&limit=100")
        items = data.get("data") or []
        out.extend(items)
        if not data.get("has_more"):
            break
        page += 1
    return out


def _get_model_config(s: _DifySession, app_id: str) -> dict:
    """Dify ≥1.10 ne sert plus GET /apps/<id>/model-config (405).
    On lit le détail complet via GET /apps/<id> qui inclut un model_config imbriqué."""
    detail = s.get(f"/apps/{app_id}")
    mc = detail.get("model_config")
    if mc is None:
        raise RuntimeError(f"App {app_id}: pas de model_config dans GET /apps/{app_id}")
    return mc


def is_applied() -> bool:
    """Vérifie si toutes les apps ont déjà max_tokens >= 8192."""
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e}) — assume not applied", file=sys.stderr)
        return False
    apps = _list_apps(s)
    if not apps:
        return True
    for app in apps:
        try:
            mc = _get_model_config(s, app["id"])
        except Exception as e:
            print(f"  is_applied: app {app.get('name','?')} GET model_config échec ({e}) — assume not applied", file=sys.stderr)
            return False
        params = (mc.get("model") or {}).get("completion_params") or {}
        mt = params.get("max_tokens")
        if mt is None or int(mt) < TARGET_MAX_TOKENS:
            return False
    return True


def run() -> None:
    """Force max_tokens=8192 sur chaque app via POST /apps/{id}/model-config."""
    s = _connect()
    apps = _list_apps(s)
    print(f"  {len(apps)} app(s) Dify à examiner")
    patched = 0
    for app in apps:
        app_id = app["id"]
        name = app.get("name", "?")
        try:
            mc = _get_model_config(s, app_id)
        except Exception as e:
            print(f"  ⚠ {name}: GET model_config échec ({e}), skip", file=sys.stderr)
            continue
        # Strip champs read-only avant POST (Dify ≥1.10 rejette ces champs en
        # entrée du PATCH model-config).
        for k in ("id", "app_id", "provider", "created_at", "updated_at"):
            mc.pop(k, None)
        model = dict(mc.get("model") or {})
        completion_params = dict(model.get("completion_params") or {})
        current = completion_params.get("max_tokens")
        # Cap qwen2.5vl:7b: num_predict ≤ 4096 côté Ollama. Si le model en cours
        # est qwen2.5vl, on ne pousse pas au-delà de 4096 sinon Dify rejette
        # avec "Model Parameter num_predict should be less than or equal to 4096".
        target = 4096 if "qwen2.5vl" in (model.get("name") or "").lower() else TARGET_MAX_TOKENS
        if current is not None and int(current) >= target:
            print(f"  - {name}: déjà à {current} (≥ {target}), skip")
            continue
        completion_params["max_tokens"] = target
        model["completion_params"] = completion_params
        mc["model"] = model
        s.post(f"/apps/{app_id}/model-config", mc)
        print(f"  ✓ {name}: max_tokens {current} → {target}")
        patched += 1
    print(f"  Total patché : {patched}/{len(apps)}")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
