"""
Hotfix : restaure le pre_prompt original de l'Assistant vision (qui a été
vidé par revert_vision_v2_prefix.py trop agressif).

Source de vérité : services/setup/app/sso_provisioning.py:1048-1058.

Usage :
    scp tools/restore_vision_prompt.py clikinfo@xefia:/tmp/
    ssh clikinfo@xefia "ADMIN_EMAIL=a.ladurelle@xefi.fr ADMIN_PASSWORD=aibox-changeme2026 \\
                        python3 /tmp/restore_vision_prompt.py"
"""
import os
import sys

import requests

BASE = "http://localhost:8081"

ORIGINAL_PROMPT = (
    "Tu es l'assistant vision de l'AI Box, spécialisé dans l'analyse "
    "d'images, captures d'écran, photos et documents avec illustrations. "
    "Réponds en français. Quand l'utilisateur joint une image, "
    "décris-la précisément, extrais le texte (OCR) si présent, "
    "identifie les éléments visuels (graphiques, tableaux, schémas, "
    "photos, captures d'écran), et réponds à sa question en t'appuyant "
    "sur ce que tu vois. Si aucune image n'est jointe, demande "
    "poliment à l'utilisateur d'en attacher une (l'Assistant général "
    "est mieux pour les questions purement textuelles)."
)

TARGET = "Assistant vision"


def main():
    email = os.environ.get("ADMIN_EMAIL")
    pwd = os.environ.get("ADMIN_PASSWORD")
    if not email or not pwd:
        sys.exit("ADMIN_EMAIL et ADMIN_PASSWORD sont requis")

    s = requests.Session()
    r = s.post(
        f"{BASE}/console/api/login",
        json={"email": email, "password": pwd, "language": "fr-FR", "remember_me": True},
        timeout=30,
    )
    r.raise_for_status()
    access = s.cookies.get("access_token")
    csrf = s.cookies.get("csrf_token")
    s.headers["Authorization"] = f"Bearer {access}"
    s.headers["X-CSRF-TOKEN"] = csrf

    apps = s.get(f"{BASE}/console/api/apps", params={"page": 1, "limit": 100}).json().get("data", [])
    target = next((a for a in apps if a["name"] == TARGET), None)
    if not target:
        sys.exit(f"Agent '{TARGET}' introuvable")

    full = s.get(f"{BASE}/console/api/apps/{target['id']}").json()
    mc = full.get("model_config") or {}
    cur = mc.get("pre_prompt", "") or ""
    print(f"[i] {TARGET}: pre_prompt actuel = {len(cur)} chars")

    for k in ["id", "app_id", "provider", "created_at", "updated_at"]:
        mc.pop(k, None)
    mc["pre_prompt"] = ORIGINAL_PROMPT
    r = s.post(f"{BASE}/console/api/apps/{target['id']}/model-config", json=mc, timeout=30)
    if not r.ok:
        sys.exit(f"PATCH failed HTTP {r.status_code}: {r.text[:300]}")
    print(f"[✓] {TARGET}: pre_prompt restauré ({len(ORIGINAL_PROMPT)} chars)")


if __name__ == "__main__":
    main()
