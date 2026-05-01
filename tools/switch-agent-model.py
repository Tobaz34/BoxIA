"""
Switch the model of a Dify app via Console API.

Usage:
  python3 switch-agent-model.py "Assistant comptable" "qwen2.5:14b"
"""
import sys, json, httpx

sys.path.insert(0, "/app")
import sso_provisioning as ssp  # noqa: E402

env = {}
with open("/srv/ai-stack/.env") as f:
    for line in f:
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")

target_app = sys.argv[1] if len(sys.argv) > 1 else "Assistant comptable"
target_model = sys.argv[2] if len(sys.argv) > 2 else "qwen2.5:14b"

base = "http://aibox-dify-nginx:80"
admin_email = env["ADMIN_EMAIL"]
admin_pwd = env["ADMIN_PASSWORD"]

c = httpx.Client(timeout=30, follow_redirects=False)

# Login Dify console
r = c.post(f"{base}/console/api/login", json={
    "email": admin_email,
    "password": admin_pwd,
    "language": "fr-FR",
    "remember_me": True,
})
if not r.is_success:
    print(f"LOGIN FAIL: {r.status_code} {r.text[:200]}")
    sys.exit(1)
data = r.json().get("data", {})
token = data.get("access_token")
H = {"Authorization": f"Bearer {token}"}

# Find target app
r = c.get(f"{base}/console/api/apps", headers=H, params={"page": 1, "limit": 50})
apps = r.json().get("data", [])
acc = next((a for a in apps if a["name"] == target_app), None)
if not acc:
    print(f"App '{target_app}' NOT FOUND. Available: {[a['name'] for a in apps]}")
    sys.exit(1)
app_id = acc["id"]
print(f"App '{target_app}' id={app_id}")

# Get current model_config
r = c.get(f"{base}/console/api/apps/{app_id}", headers=H)
detail = r.json()
mc = detail.get("model_config", {})
print(f"Current model: {json.dumps(mc.get('model'), indent=2)}")

# Update model
old_name = mc.get("model", {}).get("name", "")
mc["model"]["name"] = target_model

# Strip read-only fields
for k in ["id", "app_id", "provider", "created_at", "updated_at"]:
    mc.pop(k, None)

r = c.post(f"{base}/console/api/apps/{app_id}/model-config", headers=H, json=mc)
print(f"PATCH model-config: HTTP {r.status_code}")
if r.is_success:
    print(f"  ✓ Switched '{target_app}': {old_name} → {target_model}")
else:
    print(f"  ✗ {r.text[:400]}")
