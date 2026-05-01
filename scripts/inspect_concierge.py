"""Inspect le concierge agent dans Dify pour comprendre comment attacher le Custom Tool."""
import httpx
import json
import sys

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

    # Find concierge agent
    apps = c.get(f"{BASE}/console/api/apps?page=1&limit=50").json()
    concierge = None
    for a in apps.get("data", []):
        if "oncierge" in a.get("name", ""):
            concierge = a
            break
    if not concierge:
        print("Concierge agent not found")
        sys.exit(1)
    print(f"Concierge app: id={concierge['id']} mode={concierge.get('mode')}")

    # Get its model-config
    cfg = c.get(f"{BASE}/console/api/apps/{concierge['id']}/model-config").json()
    print("=== model-config keys ===")
    print(list(cfg.keys()))
    print("=== agent_mode ===")
    print(json.dumps(cfg.get("agent_mode", {}), indent=2)[:1500])

    # List API tool providers
    print("=== API tool providers ===")
    providers = c.get(f"{BASE}/console/api/workspaces/current/tool-providers").json()
    for p in providers if isinstance(providers, list) else providers.get("data", []):
        if isinstance(p, dict):
            name = p.get("name") or p.get("provider")
            if name and "oncierge" in name.lower():
                print(f"  Provider: {name}")
                print(f"  type: {p.get('type')}")
                print(f"  id: {p.get('id')}")
                print(f"  tools: {len(p.get('tools', []))}")
                # Liste les tools
                for t in p.get("tools", [])[:3]:
                    print(f"    - {t.get('name')}")

    # Get the API tool list specifically
    print("=== API tool list (BoxIA Concierge) ===")
    r = c.get(f"{BASE}/console/api/workspaces/current/tool-provider/api/get?provider=BoxIA Concierge Tools")
    if r.status_code == 200:
        d = r.json()
        print("provider:", d.get("provider"))
        print("tools count:", len(d.get("tools", [])))
        for t in d.get("tools", [])[:5]:
            print(f"  - {t.get('operation_id', t.get('name'))}: {t.get('description', '')[:60]}")


if __name__ == "__main__":
    main()
