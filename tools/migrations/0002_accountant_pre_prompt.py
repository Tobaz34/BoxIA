"""Migration 0002 — append règle « TRAITEMENT DES DONNÉES FOURNIES » au
pre-prompt de l'Assistant comptable existant.

Contexte : test fonctionnel 2026-05-03 (FN-03 dans
tests/ui-audit-2026-05-03/TESTS-FONCTIONNELS.md) — l'agent comptable refuse
d'analyser des données qu'on lui fournit en clair dans le message utilisateur
(relevé bancaire 10 lignes débit/crédit) et répond « je besoin des données »
alors qu'elles sont là. Cause : pre-prompt trop centré sur les conseils
théoriques (TVA, déclarations…) sans instruction explicite pour les calculs
ad-hoc sur données fournies.

Le code de provisioning (services/setup/app/sso_provisioning.py, commit
c3aecf2) a été corrigé pour les nouvelles installations. Cette migration
applique le même fix sur les déploiements existants.

Idempotence : on vérifie si la marque MARKER est déjà dans le pre_prompt
de l'app comptable. Si oui, skip. Sinon, on APPEND la règle (au lieu de
remplacer tout le pre_prompt) pour préserver d'éventuelles customisations
utilisateur.

⚠ DOIT rester en sync avec sso_provisioning.py — si le bloc ci-dessous
change ici, le changer aussi là-bas (et inversement).
"""
from __future__ import annotations

import os
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Append règle 'TRAITEMENT DES DONNÉES FOURNIES' au pre-prompt comptable (FN-03)"

DIFY_API_URL = os.environ.get(
    "DIFY_CONSOLE_API", "http://localhost:8081/console/api"
)
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get(
    "ADMIN_PASSWORD", ""
)

# Names possibles de l'app comptable (selon la version du provisioning).
# Le slug logique côté repo est "accountant" mais Dify ne stocke pas de slug,
# uniquement le name affiché.
ACCOUNTANT_APP_NAMES = {"Assistant comptable"}

# Marqueur d'idempotence : si cette chaîne est déjà dans le pre_prompt, la
# migration est considérée comme appliquée. Doit être unique et stable.
MARKER = "RÈGLE IMPORTANTE — TRAITEMENT DES DONNÉES FOURNIES"

# Bloc à appendre. Doit être strictement identique à celui du
# sso_provisioning.py (cf. commit c3aecf2). Format : 2 retours à la ligne
# avant pour bien séparer du pre-prompt existant.
APPEND_BLOCK = (
    "\n\n"
    + MARKER
    + " :\n"
    + "Si l'utilisateur te fournit des données comptables dans son message "
    "(lignes de débit/crédit, relevé bancaire, factures, FEC, CSV, tableau "
    "de chiffres…), tu DOIS les analyser et faire les calculs demandés "
    "directement. NE JAMAIS répondre 'je n'ai pas les données' quand elles "
    "sont visibles dans le prompt utilisateur — calcule, totalise, identifie "
    "les anomalies et présente le résultat structuré. Si le format est "
    "ambigu, fais une hypothèse explicite et continue."
)


# ---- Session Dify (copie de 0001 — pas de DRY pour rester self-contained
# en cas de modification future de l'API Dify console) ---------------------


class _DifySession:
    """Session HTTP authentifiée Dify console (cookies + CSRF, Dify ≥1.10)."""

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
            raise RuntimeError(
                "ADMIN_EMAIL ou ADMIN_PASSWORD manquant dans l'environnement"
            )
        payload = json.dumps(
            {
                "email": email,
                "password": password,
                "language": "fr-FR",
                "remember_me": True,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/login",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
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
            raise RuntimeError(
                f"Login Dify : pas d'access_token "
                f"(cookies={[c.name for c in self.cookiejar]}, body={body})"
            )

    def get(self, path: str) -> Any:
        req = urllib.request.Request(
            f"{self.base}{path}", headers=self._headers(), method="GET"
        )
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


def _find_accountant(apps: list[dict]) -> dict | None:
    """Retourne l'app comptable (ou None si pas trouvée)."""
    for app in apps:
        if app.get("name") in ACCOUNTANT_APP_NAMES:
            return app
    return None


def _get_model_config(s: _DifySession, app_id: str) -> dict:
    detail = s.get(f"/apps/{app_id}")
    mc = detail.get("model_config")
    if mc is None:
        raise RuntimeError(
            f"App {app_id}: pas de model_config dans GET /apps/{app_id}"
        )
    return mc


def is_applied() -> bool:
    """True si le pre_prompt comptable contient déjà MARKER."""
    try:
        s = _connect()
    except Exception as e:
        print(
            f"  is_applied: login Dify impossible ({e}) — assume not applied",
            file=sys.stderr,
        )
        return False
    apps = _list_apps(s)
    app = _find_accountant(apps)
    if app is None:
        # Pas d'app comptable trouvée : la migration ne s'applique pas (rien
        # à faire). On dit "applied" pour ne pas la rejouer indéfiniment.
        print(
            "  is_applied: aucune app 'Assistant comptable' — migration sans objet",
            file=sys.stderr,
        )
        return True
    try:
        mc = _get_model_config(s, app["id"])
    except Exception as e:
        print(
            f"  is_applied: GET model_config échec ({e}) — assume not applied",
            file=sys.stderr,
        )
        return False
    pre_prompt = mc.get("pre_prompt") or ""
    return MARKER in pre_prompt


def run() -> None:
    """Append APPEND_BLOCK au pre_prompt de l'app comptable, idempotent."""
    s = _connect()
    apps = _list_apps(s)
    app = _find_accountant(apps)
    if app is None:
        print("  Aucune app 'Assistant comptable' trouvée — rien à faire")
        return
    app_id = app["id"]
    name = app.get("name", "?")
    mc = _get_model_config(s, app_id)
    pre_prompt = mc.get("pre_prompt") or ""
    if MARKER in pre_prompt:
        print(f"  - {name}: marker déjà présent, skip")
        return
    new_pre_prompt = pre_prompt + APPEND_BLOCK
    # Strip champs read-only (cf. 0001 — Dify ≥1.10 rejette ces champs en
    # entrée du PATCH model-config).
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        mc.pop(k, None)
    mc["pre_prompt"] = new_pre_prompt
    s.post(f"/apps/{app_id}/model-config", mc)
    delta = len(APPEND_BLOCK)
    print(
        f"  ✓ {name}: pre_prompt étendu de {delta} chars "
        f"({len(pre_prompt)} → {len(new_pre_prompt)})"
    )


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
