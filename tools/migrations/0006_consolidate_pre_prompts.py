"""Migration 0006 — consolide les marqueurs 0002+0003+0004+0005 en un
seul bloc structuré et compact, plus court (≤ 1700 chars vs ~5300 chars
ajoutés cumulés).

Contexte : les 4 migrations précédentes ont ajouté ~5300 chars au
pre-prompt comptable (3000 base → 8214 final). qwen3:14b a une attention
efficace ~4-6k tokens — au-delà, l'attention se dilue et le LLM rate
des instructions (régressions acc-05 + com-03 documentées dans
BILAN-FINAL-BENCH-FAIR.md).

Cette migration :
1. SUPPRIME les blocs marqueurs 0002 + 0003 + 0004 + 0005 du pre_prompt
2. INSÈRE un seul bloc consolidé [ACCOUNTANT-RULES-V2] (1700 chars)
3. Pour les autres agents (RH, support, général, etc.) : remplace
   uniquement les marqueurs ANTI-FILE-OVERRIDE-V1 + POLISH-V2 par un
   bloc [AGENT-RULES-V2] générique (sans abattements ni références
   fiscales spécifiques compta).

Idempotente par marqueur [ACCOUNTANT-RULES-V2] / [AGENT-RULES-V2].
Préserve la base du pre-prompt (instructions de rôle initiales).
"""
from __future__ import annotations

import os
import re
import sys
from typing import Any

import http.cookiejar
import urllib.request
import urllib.error
import json

DESCRIPTION = "Consolide migrations 0002-0005 en un bloc compact ≤1700 chars (anti-attention dilution)"

DIFY_API_URL = os.environ.get(
    "DIFY_CONSOLE_API", "http://localhost:8081/console/api"
)
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get(
    "ADMIN_PASSWORD", ""
)

ACCOUNTANT_NAME = "Assistant comptable"
TARGET_AGENT_NAMES = {
    "Assistant général",
    "Assistant comptable",
    "Assistant RH",
    "Support clients",
    "Assistant juridique CGV/RGPD",
    "Assistant tri emails",
    "Assistant Q&R documents",
}

# Marqueurs des anciennes migrations à supprimer (entre eux et jusqu'à
# la prochaine section connue ou EOF).
OLD_MARKERS = [
    "RÈGLE IMPORTANTE — TRAITEMENT DES DONNÉES FOURNIES",
    "[ACCOUNTANT-FIXES-BENCH-V1]",
    "[ANTI-FILE-OVERRIDE-V1]",
    "[POLISH-V2]",
    "Abattements forfaitaires micro 2026",
]

MARKER_V2_GENERIC = "[AGENT-RULES-V2]"
MARKER_V2_ACCOUNTANT = "[ACCOUNTANT-RULES-V2]"

BLOCK_GENERIC = (
    "\n\n"
    + MARKER_V2_GENERIC
    + "\n\n"
    + "## Règles d'usage\n"
    + "1. Si l'utilisateur fournit des données dans son message (chiffres, "
    + "tableaux, texte structuré), **analyse-les directement** au lieu de "
    + "demander « les données ».\n"
    + "2. Si l'utilisateur demande une **réponse courte** (« en X lignes », "
    + "« bref », « concis »), **NE PAS générer de fichier** : réponds en "
    + "texte direct.\n"
    + "3. Si tu génères un fichier `[FILE:nom.ext]contenu[/FILE]`, **ajoute "
    + "TOUJOURS un résumé texte** de 1-3 lignes après `[/FILE]` avec les "
    + "éléments clés (montants, articles, références) demandés.\n"
    + "4. **Réutilise les noms propres** donnés par l'utilisateur (entreprise, "
    + "personne, lieu) — JAMAIS de placeholder type `[Nom du contact]`.\n"
)

BLOCK_ACCOUNTANT = (
    "\n\n"
    + MARKER_V2_ACCOUNTANT
    + "\n\n"
    + "## Règles d'usage\n"
    + "1. Données fournies dans le message → analyse-les directement, ne "
    + "demande jamais « les données ».\n"
    + "2. Réponse courte demandée (« X lignes », « bref ») → pas de fichier, "
    + "réponds en texte.\n"
    + "3. Fichier généré → résumé texte 1-3 lignes après `[/FILE]` avec les "
    + "chiffres clés (totaux, soldes).\n"
    + "4. Noms propres → réutilise tels quels (jamais `[Placeholder]`).\n\n"
    + "## Références fiscales France 2026\n"
    + "- Seuil micro-BIC vente 188 700 €, services 77 700 €, micro-BNC 77 700 €\n"
    + "- Franchise TVA vente 91 900 €, services 39 100 €, avocats 47 700 €\n"
    + "- Régime simplifié BIC vente 188 700-840 000 €, services 77 700-254 000 €\n"
    + "- Abattement forfaitaire micro-BNC **34 %**, micro-BIC services **50 %**, "
    + "micro-BIC vente **71 %** (plancher 305 €)\n"
    + "- TVA : taux normal 20 %, intermédiaire 10 %, réduit 5,5 %, particulier 2,1 %\n"
    + "- PASS 47 100 €, SMIC mensuel brut 35h 1 801,80 €\n"
    + "Si un seuil n'est pas dans cette liste et que tu n'es pas sûr, signale "
    + "« vérifiez sur impots.gouv.fr » plutôt qu'inventer.\n"
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
            raise RuntimeError("Login Dify : pas d'access_token")

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
    out, page = [], 1
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


def _strip_old_blocks(pre_prompt: str) -> str:
    """Supprime tous les blocs marqueurs 0002-0005 du pre_prompt.

    Stratégie : pour chaque marqueur (string ou regex), trouve sa première
    occurrence et coupe jusqu'au prochain marqueur OU à la fin. Marche en
    cascade jusqu'à ce que tous les marqueurs soient supprimés.

    Conserve le pre_prompt initial (avant le 1er marqueur connu).
    """
    pp = pre_prompt
    # Trouve l'offset le plus en amont parmi tous les marqueurs présents
    while True:
        first_offset = len(pp)
        first_marker = None
        for m in OLD_MARKERS:
            idx = pp.find(m)
            if idx >= 0 and idx < first_offset:
                first_offset = idx
                first_marker = m
        if first_marker is None:
            break
        # Trouve le prochain marqueur APRÈS le premier (pour borner le bloc)
        end_offset = len(pp)
        for m in OLD_MARKERS:
            if m == first_marker:
                continue
            idx = pp.find(m, first_offset + len(first_marker))
            if idx >= 0 and idx < end_offset:
                end_offset = idx
        # Coupe ce bloc — depuis quelques retours à la ligne avant le marker
        # pour ne pas laisser de "\n\n" orphelins
        cut_start = first_offset
        # Recule jusqu'à 2 \n maximum
        while cut_start > 0 and pp[cut_start - 1] in "\n ":
            cut_start -= 1
        pp = pp[:cut_start] + pp[end_offset:]
    return pp.rstrip() + "\n"


def is_applied() -> bool:
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login échec ({e})", file=sys.stderr)
        return False
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    if not targets:
        return True
    for app in targets:
        try:
            mc = _get_model_config(s, app["id"])
        except Exception:
            return False
        pre = mc.get("pre_prompt") or ""
        is_acc = app.get("name") == ACCOUNTANT_NAME
        marker = MARKER_V2_ACCOUNTANT if is_acc else MARKER_V2_GENERIC
        if marker not in pre:
            return False
        # Aussi : si l'un des vieux markers est encore là, pas appliquée
        for m in OLD_MARKERS:
            if m in pre:
                return False
    return True


def run():
    s = _connect()
    apps = _list_apps(s)
    targets = [a for a in apps if a.get("name") in TARGET_AGENT_NAMES]
    print(f"  {len(targets)} agent(s) cible(s)")

    for app in targets:
        app_id = app["id"]
        name = app.get("name", "?")
        is_acc = (name == ACCOUNTANT_NAME)
        marker = MARKER_V2_ACCOUNTANT if is_acc else MARKER_V2_GENERIC
        block = BLOCK_ACCOUNTANT if is_acc else BLOCK_GENERIC

        try:
            mc = _get_model_config(s, app_id)
        except Exception as e:
            print(f"  ⚠ {name}: GET échec ({e}), skip", file=sys.stderr)
            continue
        pre_prompt = mc.get("pre_prompt") or ""
        original_len = len(pre_prompt)

        if marker in pre_prompt and not any(m in pre_prompt for m in OLD_MARKERS):
            print(f"  - {name}: déjà consolidé (skip)")
            continue

        # 1. Supprime les vieux blocs 0002-0005
        cleaned = _strip_old_blocks(pre_prompt)

        # 2. Si le marqueur V2 était déjà là (cas partiel), retire-le aussi
        if marker in cleaned:
            idx = cleaned.find(marker)
            # Recule jusqu'aux \n
            while idx > 0 and cleaned[idx - 1] in "\n ":
                idx -= 1
            cleaned = cleaned[:idx].rstrip() + "\n"

        # 3. Append le nouveau bloc consolidé
        new_pre_prompt = cleaned.rstrip() + block

        # Garde-fou : ne PAS écrire si le résultat est plus long que l'original
        # (signe que la suppression a échoué). Tolérance de 200 chars (le bloc
        # consolidé peut être un peu plus long que ce qui a été supprimé sur
        # un agent qui n'avait que ANTI-FILE-OVERRIDE).
        if len(new_pre_prompt) > original_len + 200:
            print(f"  ⚠ {name}: nouveau pre_prompt plus long que l'original "
                  f"({len(new_pre_prompt)} > {original_len + 200}), skip par sécurité",
                  file=sys.stderr)
            continue

        for k in ("id", "app_id", "provider", "created_at", "updated_at"):
            mc.pop(k, None)
        mc["pre_prompt"] = new_pre_prompt
        s.post(f"/apps/{app_id}/model-config", mc)
        print(f"  ✓ {name}: {original_len} → {len(new_pre_prompt)} chars "
              f"(Δ {len(new_pre_prompt) - original_len:+d})")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
