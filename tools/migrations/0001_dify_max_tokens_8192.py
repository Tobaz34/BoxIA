"""Migration 0001 — force max_tokens=8192 sur toutes les apps Dify existantes.

Contexte : le provisioning historique créait les apps Dify avec max_tokens=2048,
trop bas pour qwen3:14b qui peut produire des réponses tronquées (BUG-013, fixé
par commit 5acb832 dans services/setup/app/sso_provisioning.py pour les
nouvelles installations). Cette migration applique la même correction aux
installations déjà déployées.

Idempotence : on PATCH la model_config de chaque app vers 8192 ; si déjà 8192,
le PATCH est sans effet (Dify accepte la même valeur sans erreur).
"""
from __future__ import annotations

import os
import sys
from typing import Any

import urllib.request
import urllib.error
import json

DESCRIPTION = "Force max_tokens=8192 sur toutes les apps Dify (BUG-013)"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://aibox-dify-api:5001/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
TARGET_MAX_TOKENS = 8192


def _login() -> str:
    """Retourne un access_token via le login admin Dify console."""
    if not DIFY_ADMIN_EMAIL or not DIFY_ADMIN_PASSWORD:
        raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant dans l'environnement")
    payload = json.dumps({
        "email": DIFY_ADMIN_EMAIL,
        "password": DIFY_ADMIN_PASSWORD,
        "language": "fr-FR",
        "remember_me": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{DIFY_API_URL}/login",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.loads(r.read())
    token = (body.get("data") or {}).get("access_token") or body.get("access_token")
    if not token:
        raise RuntimeError(f"Login Dify : pas de token dans {body}")
    return token


def _api_get(token: str, path: str) -> Any:
    req = urllib.request.Request(
        f"{DIFY_API_URL}{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def _api_post(token: str, path: str, body: dict) -> Any:
    req = urllib.request.Request(
        f"{DIFY_API_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def _list_apps(token: str) -> list[dict]:
    out = []
    page = 1
    while True:
        data = _api_get(token, f"/apps?page={page}&limit=100")
        items = data.get("data") or []
        out.extend(items)
        if not data.get("has_more"):
            break
        page += 1
    return out


def is_applied() -> bool:
    """Vérifie si toutes les apps ont déjà max_tokens >= 8192.

    Si oui, on saute la migration (déjà appliquée par un patch antérieur ou
    par le provisioning post-fix).
    """
    try:
        token = _login()
    except Exception as e:
        # Si on ne peut pas login, on assume "non appliqué" et run() refera l'effort
        print(f"  is_applied: login Dify impossible ({e}) — assume not applied", file=sys.stderr)
        return False
    apps = _list_apps(token)
    if not apps:
        return True  # rien à muter = déjà au target
    for app in apps:
        cfg = _api_get(token, f"/apps/{app['id']}/model-config")
        params = (cfg.get("model") or {}).get("completion_params") or {}
        mt = params.get("max_tokens")
        if mt is None or int(mt) < TARGET_MAX_TOKENS:
            return False
    return True


def run() -> None:
    """Force max_tokens=8192 sur chaque app via /apps/{id}/model-config."""
    token = _login()
    apps = _list_apps(token)
    print(f"  {len(apps)} app(s) Dify à examiner")
    patched = 0
    for app in apps:
        app_id = app["id"]
        name = app.get("name", "?")
        cfg = _api_get(token, f"/apps/{app_id}/model-config")
        model = cfg.get("model") or {}
        completion_params = dict(model.get("completion_params") or {})
        if completion_params.get("max_tokens") == TARGET_MAX_TOKENS:
            print(f"  - {name}: déjà à {TARGET_MAX_TOKENS}, skip")
            continue
        completion_params["max_tokens"] = TARGET_MAX_TOKENS
        new_model = dict(model)
        new_model["completion_params"] = completion_params
        # Le PATCH se fait via POST /apps/{id}/model-config (Dify utilise POST pour replace)
        _api_post(token, f"/apps/{app_id}/model-config", {**cfg, "model": new_model})
        print(f"  ✓ {name}: max_tokens → {TARGET_MAX_TOKENS}")
        patched += 1
    print(f"  Total patché : {patched}/{len(apps)}")


if __name__ == "__main__":
    # Permet de tester une migration unitaire : python3 0001_xxx.py
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
