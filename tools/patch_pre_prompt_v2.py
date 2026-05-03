"""
BUG-006 v2 — PATCH live : prepend une règle ABSOLUE [FILE:...] en tête du
pre_prompt des apps Dify pour que qwen3:14b respecte effectivement le
marker de génération de fichiers.

Pourquoi v2 :
  v1 (patch_pre_prompt.py) appendait l'instruction à la fin d'un prompt
  de 1500 chars. qwen3:14b ne la respectait pas — la consigne se perdait
  noyée dans la description du rôle. Validé live : "Génère un budget
  prévisionnel" produisait un tableau markdown sans marker [FILE:...].
  Seul "utilise la syntaxe [FILE:nom.xlsx]contenu[/FILE]" en EXPLICIT
  dans la query forçait le respect.

v2 :
  - PREPEND (pas append) → la règle est en TÊTE du pre_prompt, juste
    après "Tu es...". qwen3 traite mieux les instructions en début.
  - Phrasé impératif ("RÈGLE ABSOLUE — APPLIQUER SANS EXCEPTION").
  - Triggers plus larges : "Excel", "tableau", "fichier", "doc", "rapport",
    "synthèse", "présentation", "PDF" → tous mappent vers le marker.
  - Sentinel v2 (`[FILE-RULE-V2]`) pour idempotence et détection de
    l'ancien suffix v1 à supprimer.

Usage :
    scp tools/patch_pre_prompt_v2.py clikinfo@xefia:/tmp/
    ssh clikinfo@xefia "ADMIN_EMAIL=a.ladurelle@xefi.fr ADMIN_PASSWORD=aibox-changeme2026 \\
                        python3 /tmp/patch_pre_prompt_v2.py"
"""
import os
import sys

import requests

BASE = "http://localhost:8081"

SENTINEL_V2 = "[FILE-RULE-V2]"  # nouvelle balise pour idempotence v2
SENTINEL_V1 = "QUAND L'UTILISATEUR DEMANDE UN FICHIER"  # marqueur de l'ancien suffix v1

PREFIX_V2 = """[FILE-RULE-V2]
═══════════════════════════════════════════════════════════════════════
RÈGLE ABSOLUE DE GÉNÉRATION DE FICHIER — APPLIQUER SANS EXCEPTION
═══════════════════════════════════════════════════════════════════════

Tu DOIS utiliser la syntaxe [FILE:nom.ext]contenu[/FILE] dès que la
demande contient l'un de ces signaux (en français OU en anglais) :

  TRIGGERS XLSX  : "Excel", "xlsx", "tableur", "tableau" (de chiffres),
                   "budget", "devis", "facture", "compta", "bilan",
                   "liste", "récap", "données", "stats"
  TRIGGERS DOCX  : "Word", "docx", "document", "rapport", "synthèse",
                   "courrier", "lettre", "compte-rendu", "CR", "note"
  TRIGGERS PDF   : "PDF", "pdf", "imprimable", "à imprimer"
  TRIGGERS PPTX  : "PowerPoint", "pptx", "slides", "présentation"
  TRIGGERS CSV   : "CSV", "csv", "export"
  TRIGGERS CODE  : "script", ".ps1", ".sh", ".py", ".json", ".yml"

INTERDIT : produire un tableau markdown ou un bloc ```code``` quand
l'un de ces triggers est présent. Le serveur convertit le contenu DU
marker en vrai fichier téléchargeable — sans marker, l'utilisateur
n'a rien à télécharger et c'est un ÉCHEC.

FORMAT DU CONTENU DU MARKER :
  - .xlsx : tables markdown ; chaque section "## Titre" devient un onglet
  - .docx, .pdf : markdown standard (titres #, listes, **gras**, tableaux)
  - .pptx, .csv, .json, .ps1, .sh, .py : texte brut/code natif
  - Choisis un nom descriptif, sans accents, ex : devis-acme-2026.xlsx

EXEMPLES (à reproduire systématiquement) :

  USER : "Fais-moi un devis pour Acme"
  TOI  : [FILE:devis-acme.xlsx]
         ## Devis 2026-001 — Acme
         | Désignation | Quantité | PU HT | Total HT |
         |---|---|---|---|
         | Audit | 3 | 750 | 2250 |
         [/FILE]
         Total HT 2 250 €, TVA 20 % 450 €, **Total TTC 2 700 €**.

  USER : "Génère un budget prévisionnel 2026"
  TOI  : [FILE:budget-2026.xlsx]
         ## Budget 2026
         | Catégorie | Janvier | Février | ... |
         |---|---|---|---|
         | Loyer | 1500 | 1500 | ... |
         [/FILE]

  USER : "Rédige un compte-rendu de réunion"
  TOI  : [FILE:cr-reunion-2026-05-03.docx]
         # Compte-rendu de réunion
         **Date** : 2026-05-03 ...
         [/FILE]

═══════════════════════════════════════════════════════════════════════

"""

# Agents à patcher avec la règle de génération de fichiers.
# - Vision : EXCLU (il analyse les images, ne génère pas de fichiers ; le
#   prompt overhead 1.5k chars + qwen2.5vl context limité = pollution).
# - Concierge : EXCLU (mode agent-chat avec ses propres tools).
# - Marketplace dynamiques : EXCLU (créés à la volée par l'admin).
TARGET_AGENTS = {
    "Assistant général",
    "Assistant comptable",
    "Assistant RH",
    "Support clients",
    "Assistant juridique CGV/RGPD",
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


def strip_old_v1_suffix(prompt: str) -> str:
    """Supprime l'ancien SUFFIX v1 (s'il est encore présent) pour éviter
    la duplication de règles contradictoires."""
    if SENTINEL_V1 not in prompt:
        return prompt
    idx = prompt.index(SENTINEL_V1)
    # On supprime depuis "QUAND L'UTILISATEUR..." jusqu'à la fin (le
    # SUFFIX v1 était toujours appendé en bout de prompt).
    return prompt[:idx].rstrip() + "\n"


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
            print(f"  [-] {a['name']}: hors cible — skip")
            skipped_not_target += 1
            continue
        mc = get_model_config(s, a["id"])
        if not mc:
            print(f"  [!] {a['name']}: pas de model_config")
            continue
        current = mc.get("pre_prompt", "") or ""
        if SENTINEL_V2 in current:
            print(f"  [=] {a['name']}: v2 déjà présent — skip")
            skipped_already += 1
            continue
        # 1. Strip l'ancien suffix v1 s'il est là
        cleaned = strip_old_v1_suffix(current)
        # 2. Prepend la règle v2 en tête
        new_pre = PREFIX_V2 + cleaned
        mc["pre_prompt"] = new_pre
        patch_pre_prompt(s, a["id"], mc)
        patched += 1
        print(f"  [✓] {a['name']}: patched (len {len(current)} → {len(new_pre)})")

    print(f"[Done] {patched} patched / {skipped_already} déjà v2 / {skipped_not_target} hors cible")


if __name__ == "__main__":
    main()
