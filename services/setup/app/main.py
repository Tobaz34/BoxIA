"""
AI Box — Setup wizard embarqué (first-run).

Ce service tourne sur le serveur AI Box et présente un wizard graphique au
premier démarrage. Il :
  1. Affiche un wizard de qualification (questionnaire 11 chapitres)
  2. Génère .env + client_config.yaml dans /srv/ai-stack/
  3. Lance install.sh côté hôte (via socket Docker)
  4. Stream les logs en live (WebSocket)
  5. Crée /state/configured à la fin → la box bascule en mode "configurée"
"""
from __future__ import annotations

import asyncio
import os
import secrets
import string
import subprocess
from pathlib import Path
from typing import Any

import yaml
from datetime import datetime, timezone

import sso_provisioning
import template_importer

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

# ---- Config ---------------------------------------------------------------
AIBOX_ROOT = Path(os.environ.get("AIBOX_ROOT", "/srv/ai-stack"))
STATE_FILE = Path(os.environ.get("STATE_FILE", "/state/configured"))
QUESTIONNAIRE_FULL_PATH = AIBOX_ROOT / "config" / "questionnaire.yaml"
QUESTIONNAIRE_ESSENTIALS_PATH = AIBOX_ROOT / "config" / "questionnaire-essentials.yaml"

app = FastAPI(title="AI Box Setup", version="0.1.0")
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ---- Modèles --------------------------------------------------------------
class WizardSubmit(BaseModel):
    client_name: str
    client_sector: str
    users_count: int = 10
    domain: str
    admin_fullname: str
    admin_username: str
    admin_email: str
    admin_password: str           # ← saisi par l'utilisateur final, jamais loggé
    hw_profile: str = "tpe"
    technologies: dict[str, Any] = {}


# ---- Helpers --------------------------------------------------------------
def is_configured() -> bool:
    return STATE_FILE.exists()


def gen_secret(length: int = 32) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ---- Routes ---------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    """Si la box est déjà configurée → redirect vers Authentik. Sinon wizard."""
    if is_configured():
        # On suppose que NPM/Authentik tourne sur 9000 ou un domaine configuré
        return RedirectResponse(url="/configured", status_code=302)
    return templates.TemplateResponse("wizard.html", {"request": request})


@app.get("/configured", response_class=HTMLResponse)
async def configured_page(request: Request):
    return templates.TemplateResponse("configured.html", {"request": request})


@app.get("/api/state")
async def state():
    return {"configured": is_configured()}


@app.get("/api/apps")
async def list_apps(request: Request):
    """Retourne la liste des apps utilisables et leur URL.

    Logique :
      - Si DOMAIN renseigné dans .env ET Caddy edge actif
        → URLs propres https://<sub>.<DOMAIN>
      - Sinon (mode dev / POC sans reverse proxy WAN)
        → URLs IP:port directes basées sur l'host de la requête
    """
    domain = _read_env_value("DOMAIN") or ""
    use_subdomains = bool(domain) and _is_edge_caddy_running()

    # Host vu par le navigateur (utile en mode dev IP:port)
    host = (request.headers.get("host") or "").split(":")[0]
    if not host:
        host = "localhost"

    # Catalogue des apps. `port_internal` = port que le service expose en host
    # binding (ex: 0.0.0.0:9000 pour Authentik). Pour le mode sous-domaines,
    # on utilise `subdomain` à concaténer avec DOMAIN.
    catalog = [
        {"id": "auth",   "name": "Authentik",  "icon": "🔐", "desc": "SSO + Dashboard apps", "subdomain": "auth",   "port": 9000},
        {"id": "chat",   "name": "Open WebUI", "icon": "💬", "desc": "Chat IA",              "subdomain": "chat",   "port": 3000},
        {"id": "agents", "name": "Dify",       "icon": "🤖", "desc": "Agent builder",        "subdomain": "agents", "port": 8081},
        {"id": "flows",  "name": "n8n",        "icon": "⚙️", "desc": "Workflows",            "subdomain": "flows",  "port": 5678},
        {"id": "admin",  "name": "Portainer",  "icon": "🐳", "desc": "Admin containers",     "subdomain": "admin",  "port": 9443, "scheme": "https"},
        {"id": "status", "name": "Uptime",     "icon": "📊", "desc": "Monitoring services",  "subdomain": "status", "port": 3001},
    ]

    apps = []
    for app_def in catalog:
        if use_subdomains:
            url = f"https://{app_def['subdomain']}.{domain}"
        else:
            scheme = app_def.get("scheme", "http")
            url = f"{scheme}://{host}:{app_def['port']}"
        apps.append({
            "id":   app_def["id"],
            "name": app_def["name"],
            "icon": app_def["icon"],
            "desc": app_def["desc"],
            "url":  url,
        })
    return {"apps": apps, "mode": "subdomains" if use_subdomains else "direct"}


def _is_edge_caddy_running() -> bool:
    """Renvoie True si le reverse proxy Caddy edge tourne (sous-domaines disponibles)."""
    try:
        out = subprocess.run(
            ["docker", "ps", "--filter", "name=aibox-edge-caddy",
             "--filter", "status=running", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=5,
        )
        return "aibox-edge-caddy" in out.stdout
    except Exception:
        return False


@app.get("/api/questionnaire")
async def questionnaire(full: bool = False):
    """Retourne le questionnaire à afficher dans le wizard.

    Par défaut : version *essentielle* (~8 questions qui activent vraiment des
    connecteurs). Avec `?full=true` : version complète 56 items 11 chapitres
    (utile pour la fiche d'audit commerciale).
    """
    path = QUESTIONNAIRE_FULL_PATH if full else QUESTIONNAIRE_ESSENTIALS_PATH
    if not path.exists():
        raise HTTPException(500, f"Questionnaire YAML introuvable: {path}")
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@app.post("/api/configure")
async def configure(payload: WizardSubmit):
    """Reçoit la config du wizard, génère .env + client_config.yaml.

    Le mot de passe admin saisi par l'utilisateur est utilisé tel quel
    (jamais loggé, jamais retourné par l'API).
    """
    if is_configured():
        raise HTTPException(409, "Box déjà configurée")

    # Secrets internes (générés, jamais exposés au user final)
    pg_dify = gen_secret(32)
    pg_ak = gen_secret(32)
    ak_secret = gen_secret(60)
    dify_secret = gen_secret(50)
    qdrant_key = gen_secret(32)
    # Dify 1.x : plugin daemon a besoin de 2 secrets partagés avec dify-api
    dify_plugin_key = gen_secret(50)
    dify_inner_key = gen_secret(50)

    # Échappe les caractères spéciaux pour bash (.env est sourcé par scripts shell)
    def shell_escape(s: str) -> str:
        return "'" + s.replace("'", "'\"'\"'") + "'"

    env_lines = [
        f'CLIENT_NAME={shell_escape(payload.client_name)}',
        f"CLIENT_SECTOR={payload.client_sector}",
        f"CLIENT_USERS_COUNT={payload.users_count}",
        f"DOMAIN={payload.domain}",
        f"ADMIN_FULLNAME={shell_escape(payload.admin_fullname)}",
        f"ADMIN_USERNAME={payload.admin_username}",
        f"ADMIN_EMAIL={payload.admin_email}",
        f"ADMIN_PASSWORD={shell_escape(payload.admin_password)}",
        f"HW_PROFILE={payload.hw_profile}",
        "LLM_MAIN=qwen2.5:7b",
        "LLM_EMBED=bge-m3",
        f"PG_DIFY_PASSWORD={pg_dify}",
        f"PG_AUTHENTIK_PASSWORD={pg_ak}",
        f"AUTHENTIK_SECRET_KEY={ak_secret}",
        f"DIFY_SECRET_KEY={dify_secret}",
        f"DIFY_PLUGIN_DAEMON_KEY={dify_plugin_key}",
        f"DIFY_INNER_API_KEY={dify_inner_key}",
        f"QDRANT_API_KEY={qdrant_key}",
        "QDRANT_VERSION=v1.13.4",
        "DIFY_VERSION=1.10.1",
        "AUTHENTIK_VERSION=2025.10.0",
        "NETWORK_NAME=aibox_net",
    ]
    for key, val in payload.technologies.items():
        if isinstance(val, bool):
            env_lines.append(f"CLIENT_HAS_{key.upper()}={'true' if val else 'false'}")
        elif val:
            env_lines.append(f"CLIENT_TECH_{key.upper()}={shell_escape(str(val))}")

    env_path = AIBOX_ROOT / ".env"
    env_path.write_text("\n".join(env_lines) + "\n")
    env_path.chmod(0o600)

    # client_config.yaml — sans le mot de passe (sécurité)
    config = {
        "client": {
            "name": payload.client_name,
            "sector": payload.client_sector,
            "users_count": payload.users_count,
            "domain": payload.domain,
        },
        "admin": {
            "fullname": payload.admin_fullname,
            "username": payload.admin_username,
            "email": payload.admin_email,
        },
        "infrastructure": {"hw_profile": payload.hw_profile},
        "technologies": payload.technologies,
    }
    (AIBOX_ROOT / "client_config.yaml").write_text(
        yaml.dump(config, allow_unicode=True, sort_keys=False)
    )

    return {
        "status": "config_written",
        "next": "POST /api/deploy/start ou WS /api/deploy/logs pour suivre",
    }


@app.post("/api/deploy/create-admin-user")
async def create_admin_user():
    """Crée le compte administrateur dans Authentik avec les credentials saisis.

    Doit être appelé APRÈS qu'Authentik soit healthy (peut prendre 30-60s).
    Crée le user, l'ajoute au groupe `authentik Admins` (= superuser).
    Le mot de passe est passé via une variable d'environnement (évite tout
    problème de shell escape avec les caractères $ ! \\ etc.).
    """
    env_path = AIBOX_ROOT / ".env"
    if not env_path.exists():
        raise HTTPException(400, "Pas de .env — lance /api/configure d'abord")

    # Parse .env
    env: dict[str, str] = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env[k] = v.strip("'\"")

    username  = env.get("ADMIN_USERNAME", "admin")
    fullname  = env.get("ADMIN_FULLNAME", "Admin")
    email     = env.get("ADMIN_EMAIL", "admin@example.com")
    password  = env.get("ADMIN_PASSWORD", "")
    if not password:
        raise HTTPException(500, "ADMIN_PASSWORD vide dans .env")

    # Attends qu'Authentik soit VRAIMENT prêt : ak check + DB migrations terminées
    # (l'`ak check` peut répondre OK avant que les models soient disponibles).
    import time as _t
    for attempt in range(60):  # max 120s
        try:
            check = subprocess.run(
                ["docker", "exec", "aibox-authentik-server", "ak", "shell", "-c",
                 "from authentik.core.models import User, Group; "
                 "g = Group.objects.filter(name='authentik Admins').exists(); "
                 "print('READY' if g else 'NOT_READY')"],
                capture_output=True, text=True, timeout=10,
            )
            if "READY" in check.stdout:
                break
        except Exception:
            pass
        _t.sleep(2)

    # Script Python qui lit les valeurs depuis l'env (évite tout escape shell)
    script = (
        "import os\n"
        "from authentik.core.models import User, Group\n"
        "u, created = User.objects.update_or_create(\n"
        "    username=os.environ['AK_USERNAME'],\n"
        "    defaults={'name': os.environ['AK_FULLNAME'],\n"
        "              'email': os.environ['AK_EMAIL'],\n"
        "              'is_active': True})\n"
        "u.set_password(os.environ['AK_PASSWORD'])\n"
        "u.save()\n"
        "g = Group.objects.filter(name='authentik Admins').first()\n"
        "if g: u.ak_groups.add(g)\n"
        "print('USER_OK' if created else 'USER_UPDATED', "
        "'admin_group=', g is not None, "
        "'check=', u.check_password(os.environ['AK_PASSWORD']))\n"
    )

    # Retry avec backoff (3 tentatives, 5s entre chaque) — la 1ère échoue
    # parfois sur "ProgrammingError: relation 'authentik_core_user' does not exist".
    last_stdout = ""
    last_stderr = ""
    for attempt in range(3):
        try:
            out = subprocess.run(
                ["docker", "exec",
                 "-e", f"AK_USERNAME={username}",
                 "-e", f"AK_FULLNAME={fullname}",
                 "-e", f"AK_EMAIL={email}",
                 "-e", f"AK_PASSWORD={password}",
                 "aibox-authentik-server", "ak", "shell", "-c", script],
                capture_output=True, text=True, timeout=30,
            )
            last_stdout = out.stdout
            last_stderr = out.stderr
            if "USER_OK" in out.stdout or "USER_UPDATED" in out.stdout:
                return {"created": True,
                        "attempt": attempt + 1,
                        "stdout": out.stdout[-300:]}
        except subprocess.TimeoutExpired:
            last_stderr = "timeout"
        if attempt < 2:
            _t.sleep(5)  # backoff avant retry

    # 3 retries échoués → erreur HTTP claire (au lieu de retourner created:false)
    raise HTTPException(
        500,
        f"Création user Authentik échouée après 3 tentatives. "
        f"stdout={last_stdout[-200:]} stderr={last_stderr[-200:]}",
    )


@app.post("/api/deploy/provision-sso")
async def provision_sso(request: Request):
    """Provisionne le SSO et les comptes admin sur les autres apps.

    Appelé après /api/deploy/create-admin-user. Configure :
      - Open WebUI : provider OIDC complet via Authentik (vrai SSO)
      - Dify       : compte admin local (Community ne supporte pas OIDC)
      - n8n        : compte owner local (idem)
    """
    env_path = AIBOX_ROOT / ".env"
    if not env_path.exists():
        raise HTTPException(400, "Pas de .env")
    env: dict[str, str] = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env[k] = v.strip("'\"")

    host = (request.headers.get("host") or "localhost").split(":")[0]
    report = sso_provisioning.provision_all(env, host)

    # Recrée les containers qui dépendent du .env mis à jour par provisioning.
    # IMPORTANT : `docker restart` ne relit PAS les variables du .env (elles
    # sont figées au create). Il faut `docker compose up -d` pour propager
    # AUTHENTIK_APP_CLIENT_SECRET, DIFY_DEFAULT_APP_API_KEY, etc.
    compose_dirs = [
        ("open_webui", "/srv/ai-stack/services/inference"),
        ("aibox_app",  "/srv/ai-stack/services/app"),
    ]
    for ok_key, compose_dir in compose_dirs:
        if report.get(ok_key, {}).get("ok"):
            try:
                # --env-file pointe vers le .env central (les compose enfants
                # n'ont pas leur propre .env). Sans cette option, les
                # ${VARS} restent vides à la recreate.
                subprocess.run(
                    ["docker", "compose", "--env-file", "/srv/ai-stack/.env",
                     "up", "-d"],
                    cwd=compose_dir,
                    capture_output=True, timeout=120,
                )
            except Exception as e:
                print(f"[provision-sso] compose up failed for {ok_key}: {e}", flush=True)

    return report


@app.post("/api/deploy/import-templates")
def import_templates(request: Request):
    """Auto-import des templates Dify + n8n selon les techs cochées.

    Lit `client_config.yaml` pour déterminer les templates pertinents.
    Doit être appelé APRÈS provision-sso (les comptes admin doivent exister).
    Idempotent : skip les apps/workflows déjà créés.
    """
    env_path = AIBOX_ROOT / ".env"
    if not env_path.exists():
        raise HTTPException(400, "Pas de .env")
    env: dict[str, str] = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env[k] = v.strip("'\"")

    host = (request.headers.get("host") or "localhost").split(":")[0]
    return template_importer.import_all_templates(env, host)


@app.post("/api/deploy/start")
async def deploy_start():
    """Lance le déploiement complet via install.sh en mode non-interactif.

    install.sh, avec AIBOX_NONINTERACTIVE=1, lit le .env déjà écrit par
    /api/configure et démarre TOUTE la stack (Qdrant, Authentik, Dify,
    Inference, Edge Caddy).
    """
    if not (AIBOX_ROOT / ".env").exists():
        raise HTTPException(400, "Lance /api/configure d'abord")
    log_path = AIBOX_ROOT / "deploy.log"
    proc = subprocess.Popen(
        ["bash", "install.sh"],
        cwd=AIBOX_ROOT,
        env={**os.environ, "AIBOX_NONINTERACTIVE": "1"},
        stdout=open(log_path, "w"),
        stderr=subprocess.STDOUT,
    )
    return {"pid": proc.pid, "log": str(log_path)}


@app.post("/api/configure/finish")
async def configure_finish():
    """Marque la box comme configurée — le wizard ne sera plus servi."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text("configured\n")
    return {"configured": True}


# =============================================================================
# Reset "comme un nouveau client" — déclenché depuis la page configured
# =============================================================================
class ResetRequest(BaseModel):
    admin_password: str
    confirm: str    # doit valoir "RESET"


def _read_env_value(key: str) -> str | None:
    env_file = AIBOX_ROOT / ".env"
    if not env_file.exists():
        return None
    for line in env_file.read_text().splitlines():
        if line.startswith(f"{key}="):
            v = line.split("=", 1)[1].strip()
            return v.strip("'\"")
    return None


@app.post("/api/admin/reset")
def admin_reset(payload: ResetRequest):
    """Reset complet "comme un nouveau client".

    Sécurité :
      - Le mot de passe admin (depuis .env) est requis.
      - Le champ `confirm` doit valoir "RESET".

    Le reset s'exécute dans un container DOCKER SIBLING pour survivre à la
    mort du container setup-api lui-même (qui sera recréé à la fin).
    """
    if not is_configured():
        raise HTTPException(409, "Box pas encore configurée — rien à reset")
    if payload.confirm != "RESET":
        raise HTTPException(400, "Tape exactement RESET pour confirmer")

    expected = _read_env_value("ADMIN_PASSWORD")
    if not expected:
        raise HTTPException(500, "Mot de passe admin introuvable dans .env — reset impossible")
    if payload.admin_password != expected:
        raise HTTPException(401, "Mot de passe administrateur incorrect")

    # Initialise le log avec un marker (pour que le frontend voie qq chose tout de suite)
    log_path = AIBOX_ROOT / "reset.log"
    log_path.write_text(
        f"=== Reset démarré à {datetime.now(timezone.utc).isoformat()} ===\n"
        "Pull de l'image docker:cli (peut prendre 30s au 1er run)...\n"
    )

    # Tue un éventuel runner précédent
    subprocess.run(["docker", "rm", "-f", "aibox-reset-runner"],
                   capture_output=True, timeout=10)

    # Lance reset-as-client.sh dans un container Docker sibling détaché.
    # `--rm` supprime le container après exécution. `docker:cli` inclut le
    # plugin compose v2 par défaut.
    cmd = [
        "docker", "run", "--rm", "-d",
        "--name", "aibox-reset-runner",
        "-v", "/srv/ai-stack:/srv/ai-stack",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "/var/lib/aibox:/var/lib/aibox",
        "-w", "/srv/ai-stack",
        "docker:24-cli",
        "sh", "-c",
        "apk add --no-cache bash >/dev/null 2>&1; "
        "bash /srv/ai-stack/reset-as-client.sh --yes "
        ">> /srv/ai-stack/reset.log 2>&1; "
        "echo '=== Reset-runner terminé ===' >> /srv/ai-stack/reset.log",
    ]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
        log_path.open("a").write(f"runner-id: {result.stdout.strip()}\n")
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or e.stdout or str(e)).strip()
        log_path.open("a").write(f"FAIL: {msg}\n")
        raise HTTPException(500, f"Échec du lancement reset : {msg}")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Timeout au lancement du reset")
    return {
        "ok": True,
        "message": "Reset lancé. Attendez ~60 secondes puis rechargez la page.",
        "container": "aibox-reset-runner",
    }


@app.get("/api/admin/reset/status")
def reset_status():
    """Retourne l'état du reset en cours (running | finished)."""
    try:
        out = subprocess.run(
            ["docker", "ps", "--filter", "name=aibox-reset-runner", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=5,
        )
        running = "aibox-reset-runner" in out.stdout
    except Exception:
        running = False
    log_file = AIBOX_ROOT / "reset.log"
    last_lines = []
    if log_file.exists():
        try:
            last_lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]
        except Exception:
            pass
    return {"running": running, "last_lines": last_lines}


@app.websocket("/api/deploy/logs")
async def deploy_logs(ws: WebSocket):
    """Stream le contenu de deploy.log en temps réel (tail -f-like)."""
    await ws.accept()
    log_path = AIBOX_ROOT / "deploy.log"
    log_path.touch(exist_ok=True)
    try:
        with log_path.open("r") as f:
            f.seek(0, 2)  # fin du fichier
            while True:
                line = f.readline()
                if line:
                    await ws.send_text(line.rstrip("\n"))
                else:
                    await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return
