"""Migration 0018 — provisionne la KB Dify si DIFY_DEFAULT_DATASET_ID absent.

Contexte : bug fresh install xefia 2026-05-07. Sur la page /documents de
l'app, banner rouge "La base de connaissances n'est pas configurée". Le
code a fait son boulot durant provision-sso (return 200) mais le report
montre que `default_dataset` n'a jamais été persisté dans .env.

Cause possible : Dify pas encore complètement up au moment de
`_ensure_default_dataset`, ou erreur silencieuse capturée par le
try/except de sso_provisioning.py:1497-1499 ("Best-effort").

Cette migration rejoue l'opération côté run-pending.py au prochain
deploy. Idempotent.

Étapes :
1. Login Dify console (admin email/password depuis env)
2. GET /console/api/datasets pour chercher "Base de connaissances"
3. Sinon : POST /console/api/datasets pour créer
4. GET /console/api/datasets/api-keys pour récupérer la clé KB
5. Sinon : POST pour générer
6. _persist_env_var DIFY_DEFAULT_DATASET_ID + DIFY_KB_API_KEY
7. docker compose up -d --force-recreate aibox-app pour propager les vars

Auth Dify ≥1.10 : cookies httpOnly + X-CSRF-TOKEN. Pattern repris de
0001_dify_max_tokens_8192.py.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DESCRIPTION = "Provisionne KB Dify si DIFY_DEFAULT_DATASET_ID absent (Documents page bloquée)"

ENV_PATH = Path(os.environ.get("AIBOX_ENV", "/srv/ai-stack/.env"))
DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api").rstrip("/")
# DIFY_API_URL pointe sur /console/api ; pour les endpoints /datasets on
# strip le /console/api et reconstruit pour cohérence avec le code de sso_provisioning.
DIFY_BASE = DIFY_API_URL[: -len("/console/api")] if DIFY_API_URL.endswith("/console/api") else "http://localhost:8081"
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")


def _read_env_var(key: str) -> str:
    if not ENV_PATH.exists():
        return ""
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith(f"{key}=") and not line.startswith("#"):
            return line.split("=", 1)[1].strip("'\"")
    return ""


def _write_env_var(key: str, value: str) -> None:
    """Idempotent set : remplace ou append."""
    txt = ENV_PATH.read_text() if ENV_PATH.exists() else ""
    lines = txt.splitlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith(f"{key}=") and not line.startswith("#"):
            lines[i] = f"{key}={value}"
            found = True
            break
    if not found:
        lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")


class _DifySession:
    """Session HTTP authentifiée Dify console (cookies + CSRF). Cf 0001."""

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
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant")
        payload = json.dumps({
            "email": email, "password": password,
            "language": "fr-FR", "remember_me": True,
        }).encode()
        req = urllib.request.Request(
            f"{self.base}/console/api/login",
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with self.opener.open(req, timeout=15) as r:
            body = json.loads(r.read())
        self.access_token = (
            self._cookie("access_token")
            or (body.get("data") or {}).get("access_token")
            or body.get("access_token")
        )
        self.csrf_token = self._cookie("csrf_token")
        if not self.access_token:
            raise RuntimeError(f"Login Dify : no access_token (body={body})")

    def get(self, path: str) -> Any:
        req = urllib.request.Request(f"{self.base}{path}", headers=self._headers(), method="GET")
        with self.opener.open(req, timeout=15) as r:
            return json.loads(r.read())

    def post(self, path: str, body: dict) -> Any:
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode(),
            headers=self._headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with self.opener.open(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None


def is_applied() -> bool:
    """Appliqué si DIFY_DEFAULT_DATASET_ID ET DIFY_KB_API_KEY sont set."""
    ds_id = _read_env_var("DIFY_DEFAULT_DATASET_ID")
    kb_key = _read_env_var("DIFY_KB_API_KEY")
    return bool(ds_id and kb_key and kb_key.startswith("dataset-"))


EMBED_MODEL = os.environ.get("DIFY_EMBED_MODEL", "bge-m3:latest")
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_INTERNAL_URL = "http://ollama:11434"  # depuis container Dify


def _ollama_pull_if_missing(model: str) -> dict:
    """Pull le modèle d'embedding via API Ollama. Idempotent.

    Sans modèle d'embedding pulled, Dify renvoie HTTP 400 'Default model
    not found for text-embedding' au moment de créer la dataset
    (constaté fresh install xefia 2026-05-07).
    """
    # Check si déjà présent
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as r:
            models = [m.get("name", "") for m in json.loads(r.read()).get("models", [])]
        if model in models or any(m.startswith(model.split(":")[0] + ":") for m in models):
            return {"ok": True, "already": True}
    except Exception as e:
        return {"ok": False, "step": "list", "error": str(e)[:200]}

    # Pull (peut prendre 30-60s pour bge-m3 ~1.1 GB)
    try:
        payload = json.dumps({"name": model, "stream": False}).encode()
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/pull",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=600) as r:
            r.read()  # consume body
        return {"ok": True, "pulled": model}
    except Exception as e:
        return {"ok": False, "step": "pull", "error": str(e)[:200]}


def _ensure_dify_embedding(s: _DifySession, model: str) -> dict:
    """Ajoute le modèle embedding Ollama dans Dify (provider langgenius/ollama)."""
    provider = "langgenius/ollama/ollama"
    try:
        # Check si déjà ajouté
        try:
            data = s.get(f"/console/api/workspaces/current/model-providers/{provider}/models")
            for m in data.get("data", []):
                if m.get("model") == model and m.get("model_type") in ("text-embedding", "embeddings"):
                    return {"ok": True, "already": True}
        except urllib.error.HTTPError:
            pass  # Provider pas encore configuré, on continue

        r = s.post(
            f"/console/api/workspaces/current/model-providers/{provider}/models/credentials",
            {
                "model": model,
                "model_type": "text-embedding",
                "credentials": {
                    "model": model,
                    "context_size": "8192",
                    "base_url": OLLAMA_INTERNAL_URL,
                },
            },
        )
        return {"ok": True, "added": True, "response": r}
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_error": e.code, "body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _set_dify_default_embedding(s: _DifySession, model: str) -> dict:
    """Marque le modèle comme default text-embedding du workspace.

    Sans ça, /datasets refuse de créer une KB (HTTP 400 'Default model
    not found for text-embedding').
    """
    try:
        r = s.post(
            "/console/api/workspaces/current/default-model",
            {
                "model_settings": [{
                    "model_type": "text-embedding",
                    "provider": "langgenius/ollama/ollama",
                    "model": model,
                }],
            },
        )
        return {"ok": True, "response": r}
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_error": e.code, "body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _ensure_default_dataset(s: _DifySession, name: str = "Base de connaissances") -> dict:
    """Crée ou retrouve le dataset partagé."""
    try:
        data = s.get("/console/api/datasets?page=1&limit=50")
        for ds in data.get("data", []):
            if ds.get("name") == name:
                return {"ok": True, "dataset_id": ds.get("id"), "already": True}
        # Pas trouvé → créer
        r = s.post("/console/api/datasets", {
            "name": name,
            "description": "Documents partagés AI Box",
            "indexing_technique": "high_quality",
            "permission": "all_team_members",
            "provider": "vendor",
        })
        ds_id = (r or {}).get("id")
        if not ds_id:
            return {"ok": False, "error": "no dataset id returned", "body": r}
        return {"ok": True, "dataset_id": ds_id, "already": False}
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_error": e.code, "body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _ensure_dataset_api_key(s: _DifySession) -> dict:
    """Récupère ou génère la clé API Dataset (Bearer dataset-...)."""
    try:
        data = s.get("/console/api/datasets/api-keys")
        for k in data.get("data", []):
            tok = k.get("token", "")
            if tok.startswith("dataset-") and "*" not in tok:
                return {"ok": True, "api_key": tok, "already": True}
        # Sinon créer
        r = s.post("/console/api/datasets/api-keys", {})
        tok = (r or {}).get("token", "")
        if not tok:
            return {"ok": False, "error": "no token returned", "body": r}
        return {"ok": True, "api_key": tok, "already": False}
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_error": e.code, "body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _recreate_aibox_app() -> bool:
    """docker compose up --force-recreate aibox-app (relire .env)."""
    compose_dir = "/srv/ai-stack/services/app"
    if not Path(compose_dir).exists():
        return False
    try:
        r = subprocess.run(
            ["docker", "compose",
             "--env-file", str(ENV_PATH),
             "-f", f"{compose_dir}/docker-compose.yml",
             "up", "-d", "--force-recreate", "--no-build"],
            capture_output=True, text=True, timeout=180, cwd=compose_dir,
        )
        return r.returncode == 0
    except Exception:
        return False


def run() -> dict:
    if is_applied():
        return {"skipped": True, "reason": "already provisioned"}

    # 1. Pull le modèle embedding dans Ollama (sinon Dify refuse la KB)
    pull_res = _ollama_pull_if_missing(EMBED_MODEL)
    if not pull_res.get("ok"):
        return {"ok": False, "step": "ollama_pull", "result": pull_res}

    s = _DifySession(DIFY_BASE)
    try:
        s.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    except Exception as e:
        return {"ok": False, "step": "login", "error": str(e)[:200]}

    # 2. Ajoute le modèle embedding dans Dify
    embed_res = _ensure_dify_embedding(s, EMBED_MODEL)
    if not embed_res.get("ok"):
        return {"ok": False, "step": "ensure_dify_embedding", "result": embed_res}

    # 3. Marque comme default
    default_res = _set_dify_default_embedding(s, EMBED_MODEL)
    if not default_res.get("ok"):
        return {"ok": False, "step": "set_default_embedding", "result": default_res}

    # 4. Crée la dataset (KB)
    ds_res = _ensure_default_dataset(s)
    if not ds_res.get("ok"):
        return {"ok": False, "step": "ensure_dataset", "result": ds_res}
    _write_env_var("DIFY_DEFAULT_DATASET_ID", ds_res["dataset_id"])

    kb_res = _ensure_dataset_api_key(s)
    if not kb_res.get("ok"):
        return {"ok": False, "step": "ensure_kb_key", "result": kb_res, "dataset": ds_res}
    _write_env_var("DIFY_KB_API_KEY", kb_res["api_key"])

    recreated = _recreate_aibox_app()
    return {
        "ok": True,
        "dataset": {"id": ds_res["dataset_id"], "already": ds_res.get("already")},
        "kb_key": {"prefix": kb_res["api_key"][:14] + "...", "already": kb_res.get("already")},
        "aibox_app_recreated": recreated,
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
