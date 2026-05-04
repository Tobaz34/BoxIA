"""Migration 0004 — étend la règle anti-file-override à TOUS les agents
qui ont FILE-RULE-V2.

Contexte : la migration 0003 a fixé le file-override seulement pour
l'Assistant comptable. Le bench complet 20260504073733 a révélé que le
même bug existe pour les autres agents :

- rob-01-franglais (Assistant général) → génère un .docx au lieu de
  l'email texte demandé
- rob-02-contradictoire (Assistant général) → génère un .xlsx au lieu
  des 2 lignes demandées
- fil-01-budget-xlsx (Assistant comptable) → produit la table en
  markdown sans le marker [FILE:...]

Cause : FILE-RULE-V2 est appliquée à 7 agents par patch_pre_prompt_v2.py
(general, accountant, RH, support, juridique-CGV-RGPD, tri-emails,
Q&R-documents) mais sans la règle "respect contraintes user". qwen3:14b
a tendance à générer un fichier dès qu'un trigger XLSX/DOCX est dans
le prompt, même si l'user dit "5 lignes max".

Cette migration APPEND le marker [ANTI-FILE-OVERRIDE-V1] à chaque agent
de TARGET_AGENTS (sauf comptable qui a déjà le marker via 0003 — skip
si déjà présent par idempotence).

Idempotent : check du marker MARKER_ANTI_OVERRIDE par agent.

⚠ Le code de provisioning (services/setup/app/sso_provisioning.py)
contient déjà le bloc équivalent pour le comptable depuis le commit
0bb2eb9. Pour les autres agents par défaut (general, hr, support), à
ajouter dans un commit suivant si besoin pour les nouvelles installs.
"""
from __future__ import annotations

import os
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Étend la règle anti-file-override à tous les agents avec FILE-RULE-V2 (bench fix)"

DIFY_API_URL = os.environ.get(
    "DIFY_CONSOLE_API", "http://localhost:8081/console/api"
)
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get(
    "ADMIN_PASSWORD", ""
)

# Liste des agents qui ont reçu FILE-RULE-V2 (cf. patch_pre_prompt_v2.py
# TARGET_AGENTS). Le comptable est dans la liste mais sera skippé par
# idempotence (déjà patché par migration 0003).
TARGET_AGENT_NAMES = {
    "Assistant général",
    "Assistant comptable",
    "Assistant RH",
    "Support clients",
    "Assistant juridique CGV/RGPD",
    "Assistant tri emails",
    "Assistant Q&R documents",
}

MARKER_ANTI_OVERRIDE = "[ANTI-FILE-OVERRIDE-V1]"

APPEND_BLOCK = (
    "\n\n"
    + MARKER_ANTI_OVERRIDE
    + "\n\n"
    + "RÈGLE — RESPECT DES CONTRAINTES UTILISATEUR (cf. FILE-RULE-V2) :\n"
    + "Si l'utilisateur demande explicitement une réponse courte "
    + "(« en X lignes », « bref », « concis », « réponse en N phrases », "
    + "« max ... lignes »), tu NE DOIS PAS générer de fichier "
    + "[FILE:...] : réponds directement en texte court. Le fichier prive "
    + "l'utilisateur de la réponse en un coup d'œil.\n\n"
    + "Quand tu génères quand même un fichier (sans contrainte user "
    + "explicite), tu DOIS TOUJOURS terminer ta réponse par un résumé "
    + "texte de 1-3 lignes contenant les éléments clés (totaux pour un "
    + "devis/facture, points-clés pour un compte-rendu, headline pour "
    + "un pitch, etc.). Sans ce résumé, l'utilisateur doit ouvrir le "
    + "fichier pour valider — c'est un ÉCHEC produit.\n\n"
    + "Exemples :\n"
    + "  USER : « Génère un email pour annuler la réunion » (court → texte)\n"
    + "  TOI  : Bonjour [Nom], je suis désolé...[texte complet de l'email]\n"
    + "  → PAS de fichier .docx pour un email court.\n\n"
    + "  USER : « Génère un budget 2026 en xlsx »\n"
    + "  TOI  : [FILE:budget-2026.xlsx]...[/FILE]\n"
    + "         Total annuel charges : 64 800 €. Pic en avril (loyer "
    + "+ taxe foncière 2 800 €).\n"
    + "  → Résumé texte après le fichier.\n\n"
    + "  USER : « Résume cette doc en 2 lignes ET inclus les chiffres »\n"
    + "  TOI  : CA 2026 = 1.2M€ (+41% vs 2025), charges fixes -15% à "
    + "320k€, marge nette 18% vs 12%.\n"
    + "  → PAS de fichier (contrainte « 2 lignes »)."
)


# ---- Session Dify --------------------------------------------------------


class _DifySession:
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
            {"email": email, "password": password,
             "language": "fr-FR", "remember_me": True}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/login",
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
            raise RuntimeError(
                f"Login Dify : pas d'access_token "
                f"(cookies={[c.name for c in self.cookiejar]})"
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


def _get_model_config(s: _DifySession, app_id: str) -> dict:
    detail = s.get(f"/apps/{app_id}")
    mc = detail.get("model_config")
    if mc is None:
        raise RuntimeError(
            f"App {app_id}: pas de model_config dans GET /apps/{app_id}"
        )
    return mc


def _check_app(s: _DifySession, app: dict) -> tuple[bool, str]:
    """Retourne (already_applied, pre_prompt) pour un agent cible.
    Si pre_prompt ne contient pas FILE-RULE-V2, on skip aussi (l'agent
    n'a pas besoin de la patch puisqu'il n'a pas le file-override)."""
    try:
        mc = _get_model_config(s, app["id"])
    except Exception:
        return (False, "")
    pre_prompt = mc.get("pre_prompt") or ""
    return (MARKER_ANTI_OVERRIDE in pre_prompt, pre_prompt)


def is_applied() -> bool:
    """True si TOUS les agents cibles trouvés ont déjà le marker."""
    try:
        s = _connect()
    except Exception as e:
        print(
            f"  is_applied: login Dify impossible ({e}) — assume not applied",
            file=sys.stderr,
        )
        return False
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    if not targets:
        print(
            "  is_applied: aucun agent cible trouvé — migration sans objet",
            file=sys.stderr,
        )
        return True
    for app in targets:
        applied, pre = _check_app(s, app)
        # Si l'agent n'a pas FILE-RULE-V2, on considère qu'il n'a pas
        # besoin du fix (file-override pas pertinent → skip)
        if "FILE-RULE-V2" not in pre:
            continue
        if not applied:
            return False
    return True


def run() -> None:
    s = _connect()
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    print(f"  {len(targets)} agent(s) cible(s) trouvé(s)")
    patched = 0
    skipped = 0
    no_file_rule = 0
    for app in targets:
        app_id = app["id"]
        name = app.get("name", "?")
        try:
            mc = _get_model_config(s, app_id)
        except Exception as e:
            print(f"  ⚠ {name}: GET model_config échec ({e}), skip", file=sys.stderr)
            continue
        pre_prompt = mc.get("pre_prompt") or ""
        if "FILE-RULE-V2" not in pre_prompt:
            print(f"  - {name}: FILE-RULE-V2 absent (file-override pas pertinent), skip")
            no_file_rule += 1
            continue
        if MARKER_ANTI_OVERRIDE in pre_prompt:
            print(f"  - {name}: marker déjà présent, skip")
            skipped += 1
            continue
        new_pre_prompt = pre_prompt + APPEND_BLOCK
        for k in ("id", "app_id", "provider", "created_at", "updated_at"):
            mc.pop(k, None)
        mc["pre_prompt"] = new_pre_prompt
        s.post(f"/apps/{app_id}/model-config", mc)
        delta = len(APPEND_BLOCK)
        print(
            f"  ✓ {name}: pre_prompt étendu de {delta} chars "
            f"({len(pre_prompt)} → {len(new_pre_prompt)})"
        )
        patched += 1
    print(
        f"  Total : {patched} patché(s), {skipped} déjà appliqué, "
        f"{no_file_rule} sans FILE-RULE-V2"
    )


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
