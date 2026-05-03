"""
BUG-022 — PATCH live : forcer qwen2.5vl:7b sur l'app Dify "Assistant vision"

Régression du provisioning idempotent suite au merge `claude/festive-boyd-5f7cbf`
avec `-X theirs` : `_setup_one_dify_agent` ne re-applique pas le model si l'app
existe déjà. Conséquence : "Assistant vision" reste sur qwen3:14b text-only et
toute analyse d'image hallucine ou refuse.

Ce script PATCH live l'app via /console/api. Idempotent : à relancer si l'app
est recréée par un futur reset.

Usage :
    ssh xefia "ADMIN_EMAIL=a.ladurelle@xefi.fr ADMIN_PASSWORD=aibox-changeme2026 \\
               python3 /tmp/patch_vision_model.py"

Validation post-exec :
    ssh xefia "docker exec aibox-dify-db psql -U postgres -d dify -c \\
      \\"SELECT amc.model::jsonb->>'name' FROM apps a JOIN app_model_configs amc \\
      ON a.app_model_config_id = amc.id WHERE a.name='Assistant vision';\\""
    # Attendu : "qwen2.5vl:7b"
"""
import os
import sys

import requests

BASE = "http://localhost:8081"  # Port mappé aibox-dify-nginx → host (depuis le shell xefia)


def login(session, email, pwd):
    """Dify ≥1.10 ne renvoie plus le token dans le body : `{result: success}` seul.
    Les tokens (access_token, refresh_token, csrf_token) sont set en cookies
    httpOnly. L'API console exige les 3 headers : Cookie (auto), Authorization
    Bearer access_token, ET X-CSRF-TOKEN — sinon 401 'CSRF token is missing'."""
    r = session.post(
        f"{BASE}/console/api/login",
        json={"email": email, "password": pwd, "language": "fr-FR", "remember_me": True},
        timeout=30,
    )
    r.raise_for_status()
    access = session.cookies.get("access_token")
    csrf = session.cookies.get("csrf_token")
    if not access or not csrf:
        sys.exit(f"login OK mais cookies manquants. access={bool(access)} csrf={bool(csrf)}. Body: {r.text[:200]}")
    session.headers["Authorization"] = f"Bearer {access}"
    session.headers["X-CSRF-TOKEN"] = csrf
    return session


def find_app(session, name):
    r = session.get(f"{BASE}/console/api/apps", params={"page": 1, "limit": 100}, timeout=30)
    r.raise_for_status()
    for a in r.json().get("data", []):
        if a["name"] == name:
            return a["id"]
    raise SystemExit(f"App {name!r} not found")


def get_model_config(session, app_id):
    """Dify n'expose plus GET /apps/<id>/model-config (405). On lit le détail
    complet via GET /apps/<id> qui inclut un champ model_config imbriqué."""
    r = session.get(f"{BASE}/console/api/apps/{app_id}", timeout=30)
    r.raise_for_status()
    detail = r.json()
    if "model_config" not in detail:
        sys.exit(f"GET /apps/{app_id} sans model_config. Body: {r.text[:300]}")
    return detail["model_config"]


def patch_model_config(session, app_id, mc, target_model):
    """Réécrit le model_config en changeant model.name + max_tokens et en
    activant file_upload.image.enabled (sinon Dify ne route PAS l'image vers
    le LLM même si le model a vision_support).

    Strip les champs read-only que Dify rejette."""
    for k in ["id", "app_id", "provider", "created_at", "updated_at"]:
        mc.pop(k, None)
    mc["model"]["name"] = target_model
    # qwen2.5vl:7b a un cap interne num_predict ≤ 4096 (limite Ollama).
    # On reste sous ce cap côté model_config app pour éviter
    # "Model Parameter num_predict should be less than or equal to 4096.0".
    mc["model"].setdefault("completion_params", {})["max_tokens"] = 4096
    # Active le passage d'images au LLM (fournitures par UI ou par /api/chat
    # body.files[].type=image). Sans cette flag, Dify upload l'image dans
    # son storage mais ne la pousse jamais dans le prompt vision.
    fu = mc.setdefault("file_upload", {})
    img = fu.setdefault("image", {})
    img["enabled"] = True
    img.setdefault("number_limits", 3)
    img.setdefault("detail", "high")
    img.setdefault("transfer_methods", ["remote_url", "local_file"])
    r = session.post(
        f"{BASE}/console/api/apps/{app_id}/model-config",
        json=mc,
        timeout=30,
    )
    if not r.ok:
        sys.exit(f"PATCH failed HTTP {r.status_code}: {r.text[:300]}")


def main():
    email = os.environ.get("ADMIN_EMAIL")
    pwd = os.environ.get("ADMIN_PASSWORD")
    if not email or not pwd:
        sys.exit("ADMIN_EMAIL et ADMIN_PASSWORD sont requis")

    target_app = "Assistant vision"
    target_model = "qwen2.5vl:7b"

    s = requests.Session()
    login(s, email, pwd)
    app_id = find_app(s, target_app)
    print(f"[+] App {target_app!r} trouvée : id={app_id}")
    mc = get_model_config(s, app_id)
    current = mc.get("model", {}).get("name")
    print(f"[+] Model actuel  : {current}")
    img_enabled = mc.get("file_upload", {}).get("image", {}).get("enabled", False)
    print(f"[+] file_upload.image.enabled : {img_enabled}")
    if (current == target_model
            and mc["model"]["completion_params"].get("max_tokens") == 4096
            and img_enabled):
        print("[=] Déjà correct, rien à faire.")
        return
    patch_model_config(s, app_id, mc, target_model)
    print(f"[✓] Model patché  : {target_model} + max_tokens=4096 + image_upload=true")


if __name__ == "__main__":
    main()
