"""Migration 0011 — injecte un bloc d'instructions [RAG-SEARCH-V1] dans
le pre_prompt des agents qui ont le tool rag_search attaché.

Diagnostic 2026-05-05 : la migration 0010 a attaché rag_search à 3
agents (Assistant général, Concierge BoxIA, Assistant tri emails),
mais le pre_prompt de ces agents ne MENTIONNE PAS le tool ni les
règles d'usage. Résultat : qwen3:14b appelle rarement rag_search,
ou n'exploite pas les chunks retournés (réponse type « pourriez-vous
préciser votre demande ? »).

Fix : prefixer le pre_prompt existant avec un bloc explicite qui dit :
  - QUAND appeler rag_search (questions sur docs internes)
  - COMMENT (mots-clés sémantiques, pas la question complète)
  - COMMENT exploiter les résultats (citer sources, ne pas inventer)
  - QUAND NE PAS appeler (questions générales, génération fichiers)

Idempotent : marqueur `[RAG-SEARCH-V1]` en tête → re-run = no-op.

Auth Dify : cookies + X-CSRF-TOKEN, pattern partagé.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DESCRIPTION = "Injecte instructions [RAG-SEARCH-V1] dans pre_prompts des agents avec rag_search"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")

# Liste partagée avec 0010 — agents qui ont rag_search attaché.
TARGET_AGENT_NAMES = [
    "Assistant général",
    "Concierge BoxIA",
    "Assistant tri emails",
    "Assistant compta",
]

MARKER = "[RAG-SEARCH-V1]"

RAG_BLOCK = """[RAG-SEARCH-V1]
═══════════════════════════════════════════════════════════════════════
RECHERCHE DOCUMENTS — Tool rag_search
═══════════════════════════════════════════════════════════════════════

Tu as accès à un outil `rag_search` qui cherche dans les documents
internes de l'utilisateur (Google Drive, OneDrive, SharePoint).

QUAND L'UTILISER :
- Question sur le CONTENU d'un document interne (contrat, devis,
  facture, fiche client, procédure, audit, CR de réunion…)
- Recherche d'info précise sur un client / projet / employé / contrat
- Formulations type : « cherche », « regarde dans mes documents »,
  « trouve le contrat de X », « que dit le document Y », « as-tu
  accès à mes fichiers », « quelles infos sur Z »

COMMENT L'APPELER :
- Reformule en 3-6 mots-clés sémantiques (PAS la question complète) :
    user : « Que sais-tu sur le contrat ABELLO MACONNERIE ? »
    → rag_search(q="contrat ABELLO MACONNERIE")
    user : « Quelle est la procédure d'onboarding chez Pinacle ? »
    → rag_search(q="procédure onboarding Pinacle")
- Param `source` : laisse défaut `all` (cherche partout). Précise
  `gdrive` / `sharepoint` / `onedrive` uniquement si l'utilisateur
  l'a explicitement demandé.

COMMENT EXPLOITER LES RÉSULTATS :
- Le tool renvoie `{hits: [{score, name, web_url, text}]}`.
- Si au moins 1 hit a score > 0.5 : utilise les `text` pour fonder
  ta réponse, ET cite les sources en markdown : [nom](web_url).
- Si tous les scores < 0.4 : dis explicitement « Je n'ai pas trouvé
  de document pertinent sur ce sujet dans tes fichiers indexés. »
  et propose une reformulation des mots-clés.
- N'INVENTE JAMAIS un détail qui n'est pas dans les `text` retournés.
  Si l'info demandée n'est pas dans les chunks, dis-le.

QUAND NE PAS L'UTILISER :
- Question d'ordre général (sans lien avec les docs perso de l'user)
- Demande de génération de fichier (suis FILE-RULE-V2 ci-dessous)
- Question sur l'état du système BoxIA (utilise les autres tools)

═══════════════════════════════════════════════════════════════════════

"""


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


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def _has_rag_tool(model_config: dict) -> bool:
    """Détermine si l'agent a rag_search attaché (sinon on skip)."""
    tools = ((model_config or {}).get("agent_mode") or {}).get("tools") or []
    return any(t.get("tool_name") == "rag_search" for t in tools)


def _inject_rag_block(s, app_name: str) -> dict:
    app = _find_app(s, app_name)
    if not app:
        return {"app": app_name, "status": "not_found"}
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}

    if not _has_rag_tool(model_config):
        return {"app": app_name, "status": "skipped_no_rag_tool"}

    pre_prompt = model_config.get("pre_prompt") or ""
    if MARKER in pre_prompt:
        return {"app": app_name, "status": "already_applied"}

    new_pre_prompt = RAG_BLOCK + pre_prompt
    model_config["pre_prompt"] = new_pre_prompt

    # Strip read-only fields (Dify ≥1.10)
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    s.post(f"/apps/{app['id']}/model-config", model_config)
    return {
        "app": app_name,
        "status": "injected",
        "before_chars": len(pre_prompt),
        "after_chars": len(new_pre_prompt),
    }


def is_applied() -> bool:
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e})", file=sys.stderr)
        return False
    # Applied = au moins 1 agent cible existant a déjà le marker
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            continue
        cfg = s.get(f"/apps/{app['id']}")
        if not _has_rag_tool(cfg.get("model_config") or {}):
            continue
        pp = (cfg.get("model_config") or {}).get("pre_prompt") or ""
        if MARKER not in pp:
            return False
    return True


def run() -> None:
    s = _connect()
    results = []
    for name in TARGET_AGENT_NAMES:
        try:
            r = _inject_rag_block(s, name)
            results.append(r)
            print(f"  - {r}")
        except Exception as e:
            results.append({"app": name, "status": "error", "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)
    injected = sum(1 for r in results if r.get("status") == "injected")
    print(f"  ✓ Injection RAG block — {injected}/{len(TARGET_AGENT_NAMES)} agents modifiés")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
