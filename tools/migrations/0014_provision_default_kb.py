"""Migration 0014 — provisionne la Base de connaissances par défaut.

Constat sur l'install fraîche 2026-05-13 (aibox-host one-command) : l'étape
KB du wizard (`sso_provisioning.setup_dify_default_agent`, best-effort) a
échoué silencieusement → pas de dataset « Base de connaissances », pas de
`DIFY_DEFAULT_DATASET_ID` / `DIFY_KB_API_KEY` dans le .env, agents
provisionnés avec `datasets: []`. Conséquences : page /documents en 503
`kb_unavailable`, aucun RAG — alors que c'est le P1 de la roadmap produit.

Cette migration rejoue la séquence du wizard, de façon idempotente :
  1. dataset « Base de connaissances » (create si absent)
  2. clé API Service Dataset (Bearer dataset-...)
  3. persistance des 2 vars dans /srv/ai-stack/.env (le .env peut être
     root-owned 644 après un install sudo → unlink + réécriture en 600,
     le dossier appartient au user du checkout)
  4. attache le dataset aux agents par défaut (dataset_configs)

NOTE : aibox-app ne voit les nouvelles vars d'env qu'après un
`docker compose up -d` (recreate) — c.-à-d. au prochain déploiement.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

DESCRIPTION = "Provisionne la KB par défaut (dataset + clé API + attach agents) absente des installs fraîches"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")
ENV_FILE = Path(os.environ.get("AIBOX_ENV_FILE", "/srv/ai-stack/.env"))

DATASET_NAME = "Base de connaissances"
DATASET_DESCRIPTION = "Documents partagés AI Box"

# Embedding : pré-requis à la création du dataset (« Default model not
# found for text-embedding » sinon — c'est l'erreur racine qui avait fait
# échouer l'étape KB du wizard sur l'install fraîche).
EMBED_MODEL = os.environ.get("LLM_EMBED", "bge-m3:latest")
OLLAMA_PROVIDER = "langgenius/ollama/ollama"
# URL vue PAR Dify (réseau docker interne), pas par cette migration.
OLLAMA_INTERNAL_URL = os.environ.get("OLLAMA_INTERNAL_URL", "http://ollama:11434")

# Agents qui doivent retriever depuis la KB (mêmes noms que DEFAULT_AGENTS
# du wizard ; le Concierge et l'agent vision n'en ont pas besoin).
TARGET_AGENT_NAMES = [
    "Assistant général",
    "Assistant Q&R documents",
    "Assistant RH",
    "Support clients",
    "Assistant comptable",
]


# ---------------------------------------------------------------------------
# Session console Dify (cf 0008, avec corps d'erreur dans les exceptions)
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
        try:
            with self.opener.open(req, timeout=30) as r:
                raw = r.read()
                try:
                    return json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    return {"raw": raw.decode("utf-8", errors="replace")}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"POST {path} → HTTP {e.code} : {detail}") from e


def _connect():
    s = _DifySession(DIFY_API_URL)
    s.login(DIFY_ADMIN_EMAIL, DIFY_ADMIN_PASSWORD)
    return s


# ---------------------------------------------------------------------------
# Étapes
# ---------------------------------------------------------------------------

def _ensure_model_pulled(model: str) -> None:
    """Télécharge le modèle dans Ollama s'il est absent (cf wizard
    _ensure_ollama_model_pulled). Sur l'install fraîche 05-13, bge-m3
    n'avait jamais été pull → cascade : pas d'embedding Dify → pas de
    dataset → pas de RAG."""
    base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

    def _norm(n: str) -> str:
        return n[:-7] if n.endswith(":latest") else n

    with urllib.request.urlopen(f"{base}/api/tags", timeout=10) as r:
        tags = json.loads(r.read())
    present = {_norm(m.get("name", "")) for m in tags.get("models") or []}
    if _norm(model) in present:
        print(f"  - {model} déjà présent dans Ollama")
        return
    print(f"  … pull {model} dans Ollama (peut prendre quelques minutes)")
    req = urllib.request.Request(
        f"{base}/api/pull",
        data=json.dumps({"model": model}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST")
    last_status = ""
    with urllib.request.urlopen(req, timeout=1800) as r:
        for line in r:
            try:
                st = json.loads(line).get("status", "")
            except json.JSONDecodeError:
                continue
            if st and st != last_status and "pulling" not in st:
                print(f"    {st}")
                last_status = st
    print(f"  ✓ {model} pull terminé")


def _ensure_embedding_model(s) -> None:
    """Enregistre bge-m3 comme modèle text-embedding Ollama dans Dify puis
    le définit comme défaut du workspace. Idempotent (cf wizard
    _add_ollama_embedding / _set_default_embedding)."""
    already = False
    try:
        r = s.get(f"/workspaces/current/model-providers/{OLLAMA_PROVIDER}/models")
        for m in r.get("data") or []:
            if m.get("model") == EMBED_MODEL and \
               m.get("model_type") in ("text-embedding", "embeddings"):
                already = True
                break
    except Exception:
        pass
    if not already:
        s.post(
            f"/workspaces/current/model-providers/{OLLAMA_PROVIDER}/models/credentials",
            {
                "model": EMBED_MODEL,
                "model_type": "text-embedding",
                "credentials": {
                    "model": EMBED_MODEL,
                    "context_size": "8192",
                    "base_url": OLLAMA_INTERNAL_URL,
                },
            })
        print(f"  ✓ modèle embedding {EMBED_MODEL} enregistré dans Dify")
    else:
        print(f"  - modèle embedding {EMBED_MODEL} déjà enregistré")
    # Défaut workspace — sans ça, POST /datasets refuse (invalid_param).
    s.post("/workspaces/current/default-model", {
        "model_settings": [{
            "model_type": "text-embedding",
            "provider": OLLAMA_PROVIDER,
            "model": EMBED_MODEL,
        }],
    })
    print(f"  ✓ {EMBED_MODEL} défini comme text-embedding par défaut")


def _find_dataset(s) -> str | None:
    try:
        r = s.get("/datasets?page=1&limit=50")
        for ds in r.get("data") or []:
            if ds.get("name") == DATASET_NAME:
                return ds.get("id")
    except Exception:
        pass
    return None


def _ensure_dataset(s) -> str:
    ds_id = _find_dataset(s)
    if ds_id:
        print(f"  - dataset « {DATASET_NAME} » déjà présent ({ds_id})")
        return ds_id
    r = s.post("/datasets", {
        "name": DATASET_NAME,
        "description": DATASET_DESCRIPTION,
        "indexing_technique": "high_quality",
        "permission": "all_team_members",
        "provider": "vendor",
    })
    ds_id = r.get("id")
    if not ds_id:
        raise RuntimeError(f"création dataset : pas d'id dans la réponse ({str(r)[:200]})")
    print(f"  ✓ dataset « {DATASET_NAME} » créé ({ds_id})")
    return ds_id


def _ensure_dataset_api_key(s) -> str:
    # Réutilise une clé en clair si listée ; sinon en crée une (le token
    # complet n'est renvoyé qu'à la création).
    try:
        r = s.get("/datasets/api-keys")
        for k in r.get("data") or []:
            tok = k.get("token", "")
            if tok.startswith("dataset-") and "*" not in tok:
                print("  - clé Service Dataset existante réutilisée")
                return tok
    except Exception:
        pass
    r = s.post("/datasets/api-keys", {})
    tok = r.get("token", "")
    if not tok:
        raise RuntimeError("création clé dataset : pas de token renvoyé")
    print("  ✓ clé Service Dataset créée")
    return tok


def _env_get(name: str) -> str:
    if not ENV_FILE.exists():
        return ""
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return ""


def _persist_env_vars(values: dict[str, str]) -> None:
    """Écrit/replace KEY=VALUE dans le .env. Le fichier peut être root-owned
    (install sudo) : unlink + réécriture sous notre uid, en 600."""
    if not ENV_FILE.exists():
        raise RuntimeError(f"{ENV_FILE} introuvable")
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    remaining = dict(values)
    out = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else None
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    for k, v in remaining.items():
        out.append(f"{k}={v}")
    payload = "\n".join(out) + "\n"
    try:
        ENV_FILE.write_text(payload, encoding="utf-8")
    except PermissionError:
        ENV_FILE.unlink()
        ENV_FILE.write_text(payload, encoding="utf-8")
    os.chmod(ENV_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 600 : que des secrets
    print(f"  ✓ {', '.join(values)} persistées dans {ENV_FILE}")


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def _dataset_attached(model_config: dict, ds_id: str) -> bool:
    dc = (model_config or {}).get("dataset_configs") or {}
    entries = ((dc.get("datasets") or {}).get("datasets")) or []
    return any((e.get("dataset") or {}).get("id") == ds_id for e in entries)


def _attach_dataset(s, app_name: str, ds_id: str) -> str:
    app = _find_app(s, app_name)
    if not app:
        return "not_found"
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}
    if _dataset_attached(model_config, ds_id):
        return "already"
    dc = model_config.get("dataset_configs") or {
        "retrieval_model": "multiple",
        "top_k": 4,
        "score_threshold": 0.5,
        "score_threshold_enabled": False,
    }
    datasets = (dc.get("datasets") or {}).get("datasets") or []
    datasets.append({"dataset": {"enabled": True, "id": ds_id}})
    dc.setdefault("datasets", {})["datasets"] = datasets
    model_config["dataset_configs"] = dc
    # retriever_resource pour afficher les citations dans le chat
    model_config.setdefault("retriever_resource", {"enabled": True})
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)
    s.post(f"/apps/{app['id']}/model-config", model_config)
    return "attached"


# ---------------------------------------------------------------------------
# Contrat migration
# ---------------------------------------------------------------------------

def is_applied() -> bool:
    if not _env_get("DIFY_DEFAULT_DATASET_ID") or not _env_get("DIFY_KB_API_KEY"):
        return False
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e})", file=sys.stderr)
        return False
    ds_id = _find_dataset(s)
    if not ds_id:
        return False
    app = _find_app(s, "Assistant général")
    if not app:
        return True  # agents pas encore provisionnés — env + dataset suffisent
    try:
        cfg = s.get(f"/apps/{app['id']}")
        return _dataset_attached(cfg.get("model_config") or {}, ds_id)
    except Exception:
        return True


def run() -> None:
    _ensure_model_pulled(EMBED_MODEL)
    s = _connect()
    _ensure_embedding_model(s)
    ds_id = _ensure_dataset(s)
    existing_key = _env_get("DIFY_KB_API_KEY")
    kb_key = existing_key or _ensure_dataset_api_key(s)
    _persist_env_vars({
        "DIFY_DEFAULT_DATASET_ID": ds_id,
        "DIFY_KB_API_KEY": kb_key,
    })
    for name in TARGET_AGENT_NAMES:
        try:
            status = _attach_dataset(s, name, ds_id)
            print(f"  - {name}: {status}")
        except Exception as e:
            print(f"  ✗ {name}: {e}", file=sys.stderr)
    print("  ⚠ aibox-app ne lit les nouvelles vars qu'au prochain "
          "`docker compose up -d` (prochain déploiement).")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
