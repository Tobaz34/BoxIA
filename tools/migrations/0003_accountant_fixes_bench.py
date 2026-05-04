"""Migration 0003 — 2 fixes sur l'Assistant comptable révélés par le bench
20260504071200 (cf. tests/ui-audit-2026-05-03/TESTS-FONCTIONNELS.md et la
sous-section détail de /bench).

Bug 1 — BUG-FILE-OVERRIDE : l'agent génère systématiquement un fichier
xlsx quand le prompt contient des triggers ("relevé bancaire", "calcule
total", "devis"), même quand l'utilisateur demande explicitement une
réponse courte ("5 lignes max"). Cause : FILE-RULE-V2 trop agressive +
qwen3:14b qui n'inclut pas le résumé chiffré obligatoire APRÈS le
marker [/FILE]. Conséquence : score 0% ou 33% sur les prompts
acc-02/acc-05 du bench, alors que Claude répond en texte avec les
chiffres demandés.

Bug 2 — BUG-FACT-OUTDATED : qwen3:14b cite des seuils micro-BIC obsolètes
(72 600 €, qui était le seuil 2014). Les seuils 2026 sont :
  - Micro-BIC services : 77 700 €
  - Micro-BIC ventes/hébergement : 188 700 €
  - Franchise TVA services : 39 100 €
  - Franchise TVA ventes : 91 900 €
Score 50% sur acc-03 du bench à cause de cette hallucination.

Cette migration APPEND deux blocs marqueurs au pre_prompt de l'app
comptable. Idempotent via la marque MARKER_FIXES_BENCH. APPEND plutôt
que REPLACE pour préserver d'éventuelles customisations client.

⚠ Le code de provisioning (services/setup/app/sso_provisioning.py) doit
aussi être mis à jour dans le même commit pour que les nouvelles
installations bénéficient de ces fixes (sans dépendre de la migration).
"""
from __future__ import annotations

import os
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Comptable : règle 'respect contraintes user' + références fiscales 2026 (bench fix)"

DIFY_API_URL = os.environ.get(
    "DIFY_CONSOLE_API", "http://localhost:8081/console/api"
)
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get(
    "ADMIN_PASSWORD", ""
)

ACCOUNTANT_APP_NAMES = {"Assistant comptable"}

MARKER_FIXES_BENCH = "[ACCOUNTANT-FIXES-BENCH-V1]"

APPEND_BLOCK = (
    "\n\n"
    + MARKER_FIXES_BENCH
    + "\n\n"
    + "RÈGLE — RESPECT DES CONTRAINTES UTILISATEUR :\n"
    + "Si l'utilisateur demande explicitement une réponse courte "
    + "(« en X lignes », « bref », « concis », « réponse en N phrases »), "
    + "tu NE DOIS PAS générer de fichier [FILE:...] : réponds directement "
    + "en texte. Le fichier prive l'utilisateur de la réponse en un coup "
    + "d'œil.\n\n"
    + "Quand tu génères quand même un fichier, tu DOIS TOUJOURS terminer "
    + "ta réponse par un résumé texte de 1-3 lignes contenant les chiffres "
    + "clés (totaux, soldes, montants). Sans ce résumé, l'utilisateur "
    + "ne peut pas valider le contenu sans ouvrir le fichier — c'est un "
    + "ÉCHEC produit. Exemple :\n"
    + "  TOI : [FILE:devis-acme.xlsx]...[/FILE]\n"
    + "         Total HT 2 250 €, TVA 20 % 450 €, **Total TTC 2 700 €**.\n\n"
    + "RÉFÉRENCES FISCALES FRANÇAISES 2026 (à utiliser TOUJOURS, jamais "
    + "des chiffres antérieurs) :\n"
    + "  • Seuil micro-BIC vente/hébergement : 188 700 €\n"
    + "  • Seuil micro-BIC prestations services : 77 700 €\n"
    + "  • Seuil micro-BNC : 77 700 €\n"
    + "  • Franchise TVA — vente : 91 900 €\n"
    + "  • Franchise TVA — services : 39 100 €\n"
    + "  • Franchise TVA — avocats/auteurs : 47 700 €\n"
    + "  • Régime simplifié BIC vente : entre 188 700 € et 840 000 €\n"
    + "  • Régime simplifié BIC services : entre 77 700 € et 254 000 €\n"
    + "  • TVA — taux normal 20 % · intermédiaire 10 % · réduit 5,5 % · "
    + "particulier 2,1 %\n"
    + "  • Plafond annuel sécurité sociale (PASS) : 47 100 €\n"
    + "  • SMIC mensuel brut (35 h) : 1 801,80 €\n"
    + "Si on te demande un seuil et que tu n'es pas sûr, signale-le "
    + "(« vérifiez sur impots.gouv.fr ») au lieu d'inventer un chiffre."
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
    return MARKER_FIXES_BENCH in pre_prompt


def run() -> None:
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
    if MARKER_FIXES_BENCH in pre_prompt:
        print(f"  - {name}: marker déjà présent, skip")
        return
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


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
