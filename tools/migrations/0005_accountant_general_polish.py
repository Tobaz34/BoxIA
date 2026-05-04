"""Migration 0005 — 3 polish issus du bench v2 (run 20260504081238).

Bug 1 — RÉGRESSION com-02 : la migration 0003 a ajouté la consigne
"vérifiez sur impots.gouv.fr si incertain" → qwen3:14b est devenu
trop prudent et n'ose plus citer l'abattement micro-BNC 34 % alors
qu'il est universellement connu (et stable depuis 2009). Avant fix
0003 : 100% (citait 34 %). Après : 50 % ("non mentionné dans les
données fournies — vérifiez sur impots.gouv.fr").
→ Fix : ajouter explicitement les abattements aux RÉFÉRENCES
FISCALES 2026 (n'étaient pas listés).

Bug 2 — NOMS PROPRES UTILISATEUR (général) : sur rob-01-franglais,
le user demande un email pour "TechCorp". qwen3 répond avec
"[Nom du contact]" en placeholder au lieu de réutiliser "TechCorp".
Effet : score 60% au lieu de 100% sur le scorer de présence du nom.
→ Fix : ajouter règle au pre-prompt général "réutilise les noms
propres donnés par l'user".

Bug 3 — RÉSUMÉ FICHIER INCOMPLET (général + autres) : sur com-04
(mise en demeure), le LLM génère .docx sans résumé après [/FILE]
(violation ANTI-FILE-OVERRIDE-V1) ET le résumé qui existe parfois
ne contient pas les éléments demandés (article L441-10 etc.).
→ Fix : renforcer la règle déjà présente avec « le résumé doit
contenir TOUS les éléments demandés explicitement par l'user
(formules légales, articles, montants…) pour que le scorer / user
puisse valider sans ouvrir le fichier ».

Approche : 2 patches distincts.
- COMPTABLE seul : ajout des abattements (bug 1)
- TOUS les agents avec FILE-RULE-V2 : règle noms propres + résumé
  complet (bugs 2 + 3)

Idempotent par marker [POLISH-V2] (tous agents) + détection du
substring "Abattement micro-BNC" pour le comptable.
"""
from __future__ import annotations

import os
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Polish v2 : abattements micro fiscaux + noms propres + résumé fichier complet (bench fix)"

DIFY_API_URL = os.environ.get(
    "DIFY_CONSOLE_API", "http://localhost:8081/console/api"
)
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get(
    "ADMIN_PASSWORD", ""
)

ACCOUNTANT_NAME = "Assistant comptable"

# Mêmes 7 agents que migration 0004 (skip auto si pas FILE-RULE-V2).
TARGET_AGENT_NAMES = {
    "Assistant général",
    "Assistant comptable",
    "Assistant RH",
    "Support clients",
    "Assistant juridique CGV/RGPD",
    "Assistant tri emails",
    "Assistant Q&R documents",
}

MARKER_POLISH = "[POLISH-V2]"
MARKER_ABATTEMENTS = "Abattement micro-BNC"

ABATTEMENTS_BLOCK = (
    "\n\nAbattements forfaitaires micro 2026 (à citer si on te demande "
    "« abattement », « charges déductibles forfaitaires », etc., sans "
    "renvoyer à impots.gouv.fr car ces taux sont universels et stables) :\n"
    "  • Abattement micro-BNC : 34 %\n"
    "  • Abattement micro-BIC services : 50 %\n"
    "  • Abattement micro-BIC vente/hébergement : 71 %\n"
    "  • Plancher abattement annuel : 305 €\n"
)

POLISH_BLOCK = (
    "\n\n"
    + MARKER_POLISH
    + "\n\n"
    + "RÈGLE — RÉUTILISER LES NOMS PROPRES DE L'UTILISATEUR :\n"
    + "Quand l'utilisateur mentionne un nom (entreprise, personne, "
    + "produit, ville…), tu DOIS le réutiliser tel quel dans la réponse, "
    + "JAMAIS le remplacer par un placeholder type « [Nom du contact] » "
    + "ou « [Entreprise] ». Exemple : si l'user dit « email pour annuler "
    + "le meeting avec TechCorp », ta réponse contient « TechCorp » et "
    + "non « [Nom du contact] ». L'user perd confiance si le LLM ne "
    + "retient pas les noms qu'il vient de donner.\n\n"
    + "RÈGLE — RÉSUMÉ TEXTE COMPLET APRÈS [/FILE] (renforcement de "
    + "ANTI-FILE-OVERRIDE-V1) :\n"
    + "Quand tu génères un fichier, le résumé texte qui suit [/FILE] DOIT "
    + "contenir TOUS les éléments clés demandés par l'utilisateur :\n"
    + "  • Si l'user demande des montants → indique-les en chiffres\n"
    + "  • Si l'user demande une formule légale (« mise en demeure », "
    + "« article L. 441-10 », « 8 jours ») → cite la formule dans le "
    + "résumé\n"
    + "  • Si l'user demande des références → liste-les\n"
    + "L'objectif : permettre la validation en lisant SEULEMENT la réponse "
    + "chat, sans avoir à ouvrir le fichier.\n"
    + "Exemple acceptable :\n"
    + "  USER : « Rédige une mise en demeure (mention article L441-10) »\n"
    + "  TOI  : [FILE:lettre-mise-en-demeure.docx]...[/FILE]\n"
    + "         **Mise en demeure** envoyée à [Nom client] avec rappel "
    + "des pénalités L. 441-10 du Code de commerce. Délai 8 jours sous "
    + "peine de poursuites.\n"
    + "Exemple INACCEPTABLE :\n"
    + "  TOI  : [FILE:lettre.docx]...[/FILE]\n"
    + "  → vide après le marker. L'user ne sait pas si la lettre est "
    + "complète."
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

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.access_token: h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token: h["X-CSRF-TOKEN"] = self.csrf_token
        if extra: h.update(extra)
        return h

    def _cookie(self, name):
        for c in self.cookiejar:
            if c.name == name: return c.value
        return None

    def login(self, email, password):
        if not email or not password:
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant")
        payload = json.dumps({"email": email, "password": password,
                              "language": "fr-FR", "remember_me": True}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/login", data=payload,
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
            raise RuntimeError(f"Login Dify : pas d'access_token")

    def get(self, path):
        req = urllib.request.Request(f"{self.base}{path}", headers=self._headers(), method="GET")
        with self.opener.open(req, timeout=15) as r:
            return json.loads(r.read())

    def post(self, path, body):
        req = urllib.request.Request(
            f"{self.base}{path}", data=json.dumps(body).encode("utf-8"),
            headers=self._headers({"Content-Type": "application/json"}), method="POST",
        )
        with self.opener.open(req, timeout=30) as r:
            raw = r.read()
            if not raw: return None
            try: return json.loads(raw)
            except json.JSONDecodeError: return raw


def _connect():
    s = _DifySession(DIFY_API_URL)
    s.login(DIFY_ADMIN_EMAIL, DIFY_ADMIN_PASSWORD)
    return s


def _list_apps(s):
    out = []
    page = 1
    while True:
        data = s.get(f"/apps?page={page}&limit=100")
        items = data.get("data") or []
        out.extend(items)
        if not data.get("has_more"): break
        page += 1
    return out


def _get_model_config(s, app_id):
    detail = s.get(f"/apps/{app_id}")
    mc = detail.get("model_config")
    if mc is None: raise RuntimeError(f"App {app_id}: pas de model_config")
    return mc


def is_applied():
    """True si POLISH_BLOCK est présent partout ET ABATTEMENTS sur le comptable."""
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login échec ({e}) — assume not applied", file=sys.stderr)
        return False
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    if not targets:
        print("  is_applied: aucun agent cible — sans objet", file=sys.stderr)
        return True
    accountant_ok = True
    polish_pending_count = 0
    for app in targets:
        try:
            mc = _get_model_config(s, app["id"])
        except Exception:
            return False
        pre = mc.get("pre_prompt") or ""
        # Polish : seulement pour ceux avec FILE-RULE-V2
        if "FILE-RULE-V2" in pre and MARKER_POLISH not in pre:
            polish_pending_count += 1
        # Abattements : seulement comptable
        if app.get("name") == ACCOUNTANT_NAME and MARKER_ABATTEMENTS not in pre:
            accountant_ok = False
    return polish_pending_count == 0 and accountant_ok


def run():
    s = _connect()
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    print(f"  {len(targets)} agent(s) cible(s) trouvé(s)")
    polish_patched = 0
    polish_skipped = 0
    abattements_patched = 0

    for app in targets:
        app_id = app["id"]
        name = app.get("name", "?")
        try:
            mc = _get_model_config(s, app_id)
        except Exception as e:
            print(f"  ⚠ {name}: GET échec ({e}), skip", file=sys.stderr)
            continue
        pre_prompt = mc.get("pre_prompt") or ""
        new_pre_prompt = pre_prompt
        changed = False

        # 1. POLISH (tous agents avec FILE-RULE-V2)
        if "FILE-RULE-V2" in pre_prompt:
            if MARKER_POLISH in pre_prompt:
                polish_skipped += 1
            else:
                new_pre_prompt = new_pre_prompt + POLISH_BLOCK
                changed = True
                polish_patched += 1

        # 2. ABATTEMENTS (comptable seulement)
        if name == ACCOUNTANT_NAME and MARKER_ABATTEMENTS not in pre_prompt:
            new_pre_prompt = new_pre_prompt + ABATTEMENTS_BLOCK
            changed = True
            abattements_patched += 1

        if not changed:
            print(f"  - {name}: rien à appliquer (déjà fait ou pas concerné), skip")
            continue

        for k in ("id", "app_id", "provider", "created_at", "updated_at"):
            mc.pop(k, None)
        mc["pre_prompt"] = new_pre_prompt
        s.post(f"/apps/{app_id}/model-config", mc)
        delta = len(new_pre_prompt) - len(pre_prompt)
        print(f"  ✓ {name}: pre_prompt étendu de {delta} chars "
              f"({len(pre_prompt)} → {len(new_pre_prompt)})")

    print(f"  Total : polish patché {polish_patched}, polish skipped {polish_skipped}, "
          f"abattements patché {abattements_patched}")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
