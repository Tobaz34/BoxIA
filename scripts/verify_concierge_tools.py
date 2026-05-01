"""Verify que l'agent concierge a bien les tools attachés."""
import httpx
import json

BASE = "http://aibox-dify-nginx:80"


def parse_env(path: str) -> dict:
    env = {}
    for line in open(path).read().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env[k] = v.strip().strip("'\"")
    return env


def main():
    env = parse_env("/srv/ai-stack/.env")
    c = httpx.Client(timeout=15)
    r = c.post(f"{BASE}/console/api/login",
               json={"email": env["ADMIN_EMAIL"], "password": env["ADMIN_PASSWORD"]})
    tok = r.cookies.get("access_token")
    csrf = r.cookies.get("csrf_token")
    c.headers["Authorization"] = f"Bearer {tok}"
    if csrf:
        c.headers["X-CSRF-TOKEN"] = csrf

    apps = c.get(f"{BASE}/console/api/apps?page=1&limit=50").json()
    concierge = next((a for a in apps.get("data", []) if "oncierge" in a.get("name", "")), None)
    if not concierge:
        print("Concierge not found")
        return
    print(f"Concierge: {concierge['id']} mode={concierge.get('mode')}")

    # Try to get the model-config (multiple possible endpoints)
    for ep in [
        f"/console/api/apps/{concierge['id']}",
        f"/console/api/apps/{concierge['id']}/model-config",
    ]:
        r = c.get(f"{BASE}{ep}")
        print(f"  GET {ep} → {r.status_code}")
        if r.status_code == 200:
            d = r.json()
            am = d.get("agent_mode") or d.get("model_config", {}).get("agent_mode")
            if am:
                print(f"    agent_mode.enabled = {am.get('enabled')}")
                print(f"    agent_mode.tools count = {len(am.get('tools', []))}")
                for t in am.get("tools", [])[:5]:
                    print(f"      - {t.get('tool_name')} (provider={t.get('provider_name')}, enabled={t.get('enabled')})")
                break


if __name__ == "__main__":
    main()
