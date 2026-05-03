"""
BUG-006 — PATCH live : ajoute le suffix [FILE:...] aux pre_prompts des
apps Dify existantes pour enseigner aux agents la syntaxe de génération
de fichiers (markdown → DOCX/XLSX/PDF/PS1/etc).

Idempotent : ne ré-applique pas si le suffix est déjà présent (vérif via
sentinel `[FILE:nom.ext]contenu[/FILE]` dans le pre_prompt).

Usage :
    ssh xefia "ADMIN_EMAIL=a.ladurelle@xefi.fr ADMIN_PASSWORD=aibox-changeme2026 \\
               python3 /tmp/patch_pre_prompt.py"

Cibles : tous les agents principaux (général, comptable, RH, support,
juridique, vision, tri-emails). Le Concierge BoxIA est SKIP car il est en
mode agent-chat avec ses propres tools (install_workflow, etc.) et n'a
pas vocation à générer des fichiers — il en commande indirectement.
"""
import os
import sys

import requests

BASE = "http://localhost:8081"

SENTINEL = "[FILE:nom.ext]"  # présent dans le suffix → idempotence

SUFFIX = """

QUAND L'UTILISATEUR DEMANDE UN FICHIER (.docx, .xlsx, .pptx, .pdf, .csv, .ps1, .sh, .py, .json) :
- Réponds UNIQUEMENT avec le marker [FILE:nom.ext]contenu[/FILE].
- Pas de markdown explicatif AVANT le marker. Tu peux ajouter du commentaire APRÈS.
- Format du contenu :
  - .docx : markdown standard (titres #, listes, tableaux, **gras**, *italique*)
  - .xlsx : tables markdown — chaque section H2 (## Titre) devient un onglet
  - .pdf  : markdown standard
  - .pptx, .csv, .json, .md, .ps1, .sh, .py : texte brut/code dans le format attendu
- Choisis un nom de fichier descriptif sans accents, ex: devis-acme-2026.xlsx
- Le serveur convertit automatiquement et renvoie un lien de téléchargement.

Exemple :
  Voici votre devis :

  [FILE:devis-acme.xlsx]
  ## Devis 2026-001 — Acme

  | Désignation | Quantité | PU HT | Total HT |
  |---|---|---|---|
  | Audit | 3 | 750 | 2250 |
  [/FILE]

  Total HT 2 250 €, TVA 20 % 450 €, **Total TTC 2 700 €**.
"""

# Agents à patcher. Les autres (Concierge, agents marketplace dynamiques) sont skip.
TARGET_AGENTS = {
    "Assistant général",
    "Assistant comptable",
    "Assistant RH",
    "Support clients",
    "Assistant juridique CGV/RGPD",
    "Assistant vision",
    "Assistant tri emails",
    "Assistant Q&R documents",
}


def login(session, email, pwd):
    r = session.post(
        f"{BASE}/console/api/login",
        json={"email": email, "password": pwd, "language": "fr-FR", "remember_me": True},
        timeout=30,
    )
    r.raise_for_status()
    access = session.cookies.get("access_token")
    csrf = session.cookies.get("csrf_token")
    if not access or not csrf:
        sys.exit("login OK mais cookies manquants")
    session.headers["Authorization"] = f"Bearer {access}"
    session.headers["X-CSRF-TOKEN"] = csrf
    return session


def list_apps(session):
    r = session.get(f"{BASE}/console/api/apps", params={"page": 1, "limit": 100}, timeout=30)
    r.raise_for_status()
    return r.json().get("data", [])


def get_model_config(session, app_id):
    r = session.get(f"{BASE}/console/api/apps/{app_id}", timeout=30)
    r.raise_for_status()
    return r.json().get("model_config")


def patch_pre_prompt(session, app_id, mc):
    for k in ["id", "app_id", "provider", "created_at", "updated_at"]:
        mc.pop(k, None)
    r = session.post(
        f"{BASE}/console/api/apps/{app_id}/model-config", json=mc, timeout=30,
    )
    if not r.ok:
        sys.exit(f"PATCH failed HTTP {r.status_code}: {r.text[:300]}")


def main():
    email = os.environ.get("ADMIN_EMAIL")
    pwd = os.environ.get("ADMIN_PASSWORD")
    if not email or not pwd:
        sys.exit("ADMIN_EMAIL et ADMIN_PASSWORD sont requis")

    s = requests.Session()
    login(s, email, pwd)

    apps = list_apps(s)
    print(f"[+] {len(apps)} apps trouvées dans Dify")

    patched = 0
    skipped_already = 0
    skipped_not_target = 0

    for a in apps:
        if a["name"] not in TARGET_AGENTS:
            skipped_not_target += 1
            continue
        mc = get_model_config(s, a["id"])
        if not mc:
            print(f"  [!] {a['name']}: pas de model_config — skip")
            continue
        current = mc.get("pre_prompt", "") or ""
        if SENTINEL in current:
            print(f"  [=] {a['name']}: suffix déjà présent — skip")
            skipped_already += 1
            continue
        new_pre = (current.rstrip() + SUFFIX) if current.strip() else SUFFIX.lstrip()
        mc["pre_prompt"] = new_pre
        patch_pre_prompt(s, a["id"], mc)
        print(f"  [✓] {a['name']}: +{len(SUFFIX)} chars (total {len(new_pre)})")
        patched += 1

    print(f"[Done] {patched} patched / {skipped_already} déjà OK / "
          f"{skipped_not_target} hors cible")


if __name__ == "__main__":
    main()
