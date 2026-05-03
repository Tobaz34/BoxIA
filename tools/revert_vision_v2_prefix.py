"""
Hotfix : retire le prefix [FILE-RULE-V2] du pre_prompt de l'Assistant
vision (qui ne génère pas de fichier, juste analyse d'images).

Le prefix avait été ajouté par erreur dans la première run de
patch_pre_prompt_v2.py (Vision était dans TARGET_AGENTS). Corrigé
côté tool — ce script nettoie le prompt déjà patché.

Idempotent : skip si pas de prefix v2.

Usage :
    scp tools/revert_vision_v2_prefix.py clikinfo@xefia:/tmp/
    ssh clikinfo@xefia "ADMIN_EMAIL=a.ladurelle@xefi.fr ADMIN_PASSWORD=aibox-changeme2026 \\
                        python3 /tmp/revert_vision_v2_prefix.py"
"""
import os
import sys

import requests

BASE = "http://localhost:8081"
SENTINEL_V2 = "[FILE-RULE-V2]"
END_MARKER = "═══════════════════════════════════════════════════════════════════════"

TARGET = "Assistant vision"


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


def main():
    email = os.environ.get("ADMIN_EMAIL")
    pwd = os.environ.get("ADMIN_PASSWORD")
    if not email or not pwd:
        sys.exit("ADMIN_EMAIL et ADMIN_PASSWORD sont requis")

    s = requests.Session()
    login(s, email, pwd)

    apps = s.get(f"{BASE}/console/api/apps", params={"page": 1, "limit": 100}).json().get("data", [])
    target = next((a for a in apps if a["name"] == TARGET), None)
    if not target:
        sys.exit(f"Agent '{TARGET}' introuvable")

    full = s.get(f"{BASE}/console/api/apps/{target['id']}").json()
    mc = full.get("model_config") or {}
    pp = mc.get("pre_prompt", "") or ""

    # Détecte tout résidu du bloc v2 (marker, "Tu DOIS utiliser la syntaxe",
    # exemples avec [FILE:...]). On strip chirurgicalement basé sur des
    # ancres robustes : début = "Tu DOIS utiliser la syntaxe [FILE:" OU
    # "[FILE-RULE-V2]" ; fin = la dernière "[/FILE]" suivie d'une ligne vide
    # ou la ligne "═══" terminale.
    BLOCK_START_MARKERS = [SENTINEL_V2, "Tu DOIS utiliser la syntaxe [FILE:"]
    start = -1
    for marker in BLOCK_START_MARKERS:
        if marker in pp:
            idx = pp.index(marker)
            if start < 0 or idx < start:
                start = idx
    if start < 0:
        print(f"[=] {TARGET}: pas de bloc file-rule — rien à faire")
        return

    # Trouve le dernier "[/FILE]" qui marque la fin des exemples
    last_close = pp.rfind("[/FILE]", start)
    if last_close < 0:
        print(f"[!] {TARGET}: bloc trouvé mais pas de [/FILE] de fin — abort")
        return
    cut_at = last_close + len("[/FILE]")
    # Inclure la ligne d'explication "Total HT 2 250 €..." qui suit le
    # dernier exemple devis (jusqu'au prochain "═══" ou fin de paragraphe)
    nl = pp.find("\n", cut_at)
    if nl > 0 and nl < cut_at + 200:
        # Voir si la ligne suivante est encore une explication d'exemple
        next_line = pp[cut_at:nl].strip()
        if next_line and not next_line.startswith("═"):
            # Probablement une suite d'exemple (ex: "Total HT 2 250 €...")
            cut_at = nl
    # Si bloc se termine par "═══" séparateur, l'inclure
    eq_after = pp.find(END_MARKER, cut_at)
    if eq_after >= 0 and eq_after < cut_at + 50:
        cut_at = eq_after + len(END_MARKER)
    # Skip newlines suivants
    while cut_at < len(pp) and pp[cut_at] in "\n\r":
        cut_at += 1

    # Avant `start`, on peut avoir des "═══" résiduels — strip-les aussi
    before = pp[:start].rstrip()
    while before.endswith(END_MARKER):
        before = before[:-len(END_MARKER)].rstrip()

    cleaned = before + ("\n\n" if before else "") + pp[cut_at:]

    for k in ["id", "app_id", "provider", "created_at", "updated_at"]:
        mc.pop(k, None)
    mc["pre_prompt"] = cleaned
    r = s.post(f"{BASE}/console/api/apps/{target['id']}/model-config", json=mc, timeout=30)
    if not r.ok:
        sys.exit(f"PATCH failed HTTP {r.status_code}: {r.text[:300]}")
    print(f"[✓] {TARGET}: prefix v2 retiré (len {len(pp)} → {len(cleaned)})")


if __name__ == "__main__":
    main()
