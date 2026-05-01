"""
Enregistre un modèle Ollama dans Dify (provider langgenius/ollama/ollama).
Sans cette étape, l'app Dify renvoie 'dify_upstream_error'.

Usage : python3 register-ollama-model.py <model_name> [vision_support=false]
Exemple : python3 register-ollama-model.py qwen2.5:14b false
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

model_name = sys.argv[1] if len(sys.argv) > 1 else "qwen2.5:14b"

base = "http://aibox-dify-nginx:80"
admin_email = env["ADMIN_EMAIL"]
admin_pwd = env["ADMIN_PASSWORD"]

c = ssp._dify_console_client(base, admin_email, admin_pwd)
if not c:
    print("Login Dify console failed")
    sys.exit(1)

print(f"Registering Ollama model '{model_name}'...")
result = ssp._add_ollama_model(c, base, model_name)
print(json.dumps(result, indent=2, ensure_ascii=False))
