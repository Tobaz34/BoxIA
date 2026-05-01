"""Affiche un résumé lisible du résultat de /api/deploy/provision-sso."""
import json, sys

d = json.load(open("/tmp/prov.json"))

print("=== overview ===")
for k in ["aibox_app", "open_webui", "authentik_branding", "dify",
          "n8n", "ak_management", "portainer"]:
    v = d.get(k, {})
    print(f"  {k}: ok={v.get('ok')}  {str(v.get('note', ''))[:80]}  err={str(v.get('error', ''))[:80]}")

print()
print("=== dify_agent ===")
da = d.get("dify_agent", {})
print(f"  model:         {da.get('model')}")
print(f"  ollama_model:  {da.get('ollama_model')}")
print(f"  ollama_vision: {da.get('ollama_vision')}")
print(f"  embed:         {da.get('embed_model')}")
print()
for slug, info in (da.get("agents") or {}).items():
    print(f"  agent {slug:12s}: ok={info.get('ok')} model_config_ok={info.get('model_config_ok')}  api_key={(info.get('api_key_prefix') or '?')[:14]}")
