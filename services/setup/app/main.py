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

# Mot de passe par défaut livré avec la box. Le wizard ne demande PAS au
# client de saisir un mot de passe (évite les fautes de frappe lors de
# l'install). Le client doit le changer à sa 1re connexion ; un flag
# `must_change_password=True` est posé sur l'utilisateur Authentik et
# l'app principale détecte ce flag pour afficher une bannière persistante.
# Override possible via l'env BOXIA_DEFAULT_PASSWORD si on veut un mdp
# par-box (printé sur sticker par exemple).
DEFAULT_ADMIN_PASSWORD = os.environ.get("BOXIA_DEFAULT_PASSWORD", "aibox-changeme!")

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
    admin_username: str = "admin"
    admin_email: str
    # Optionnel : si non fourni, on utilise DEFAULT_ADMIN_PASSWORD. Le
    # wizard officiel ne demande plus de mot de passe ; ce champ reste
    # accepté pour des intégrations alternatives (CI, scripts, custom).
    admin_password: str = ""
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

    # Si pas de mot de passe fourni, on utilise le default livré avec la
    # box. Le client le changera à sa 1re connexion (must_change_password
    # est posé sur l'user Authentik, voir create-admin-user).
    if not payload.admin_password:
        payload.admin_password = DEFAULT_ADMIN_PASSWORD

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

    # Mode LAN (.local) ou prod selon le domaine choisi.
    #   .local  → Caddy edge avec certs internes auto-signés, NextAuth doit
    #             tolérer le cert auto-signé pour son back-channel server→server.
    #   public  → Let's Encrypt prod, certs valides.
    #
    # NODE_TLS_REJECT_UNAUTHORIZED utilise la SÉMANTIQUE INVERSE :
    #   0 = accepte les certs auto-signés (mode LAN)
    #   1 = rejette les certs auto-signés (mode prod, default safe)
    is_lan_mdns = payload.domain.endswith(".local")
    if is_lan_mdns:
        domain_prefix = payload.domain.removesuffix(".local") or "aibox"
        acme_ca = "internal"
        allow_self_signed = "1"
        node_tls_reject = "0"   # NextAuth tolère le cert Caddy auto-signé
    else:
        domain_prefix = "aibox"  # non utilisé sur domaine public, mais défini
        acme_ca = "letsencrypt prod"
        allow_self_signed = "0"
        node_tls_reject = "1"   # default safe (cert valides en prod)

    env_lines = [
        f'CLIENT_NAME={shell_escape(payload.client_name)}',
        f"CLIENT_SECTOR={payload.client_sector}",
        f"CLIENT_USERS_COUNT={payload.users_count}",
        f"DOMAIN={payload.domain}",
        f"DOMAIN_PREFIX={domain_prefix}",
        f"ACME_CA={acme_ca}",
        f"ALLOW_SELF_SIGNED={allow_self_signed}",
        f"NODE_TLS_REJECT_UNAUTHORIZED={node_tls_reject}",
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

    # Attends qu'Authentik soit VRAIMENT prêt : check progressif qui exerce
    # plus que l'existence du groupe — il faut aussi pouvoir lire/écrire la
    # table users (les migrations peuvent être terminées mais la session
    # de bootstrap encore en train de seeder, ce qui crée des conflits sur
    # update_or_create).
    import time as _t
    ready = False
    for attempt in range(60):  # max ~180s (30 attempts × 3s + travail)
        try:
            check = subprocess.run(
                ["docker", "exec", "aibox-authentik-server", "ak", "shell", "-c",
                 "from authentik.core.models import User, Group; "
                 "from django.db import connection; "
                 # Force une requête réelle (pas juste exists) pour vérifier
                 # que la connexion DB est stable et que les migrations sont
                 # complètement appliquées.
                 "g = Group.objects.filter(name='authentik Admins').first(); "
                 "n = User.objects.count(); "
                 "print('READY' if g and n >= 0 else 'NOT_READY')"],
                capture_output=True, text=True, timeout=15,
            )
            if "READY" in check.stdout:
                ready = True
                break
        except Exception:
            pass
        _t.sleep(3)
    # Marge supplémentaire pour laisser Authentik finir ses tasks de
    # bootstrap (création des outpost-users etc.) — sinon update_or_create
    # peut entrer en conflit avec la création concurrente d'un user.
    if ready:
        _t.sleep(10)

    # Le password est-il celui par défaut (aibox-changeme!) ?
    # Si oui → on pose le flag must_change_password=True sur l'user pour
    # que l'app principale affiche une bannière de rappel à la 1re
    # connexion. Sinon (mode legacy / custom-pwd) → flag à False.
    is_default_pwd = (password == DEFAULT_ADMIN_PASSWORD)

    # Script Python qui lit les valeurs depuis l'env (évite tout escape shell)
    # Le flag `must_change_password` est stocké dans User.attributes (JSONField)
    # — visible aussi via OIDC userinfo en tant que claim si on l'expose dans
    # le mapping Authentik (configuré par sso_provisioning.py).
    script = (
        "import os, json\n"
        "from authentik.core.models import User, Group\n"
        "must_change = os.environ.get('AK_MUST_CHANGE_PWD', '0') == '1'\n"
        "u, created = User.objects.update_or_create(\n"
        "    username=os.environ['AK_USERNAME'],\n"
        "    defaults={'name': os.environ['AK_FULLNAME'],\n"
        "              'email': os.environ['AK_EMAIL'],\n"
        "              'is_active': True})\n"
        "u.set_password(os.environ['AK_PASSWORD'])\n"
        "# Pose ou retire le flag selon le mode (default vs custom pwd).\n"
        "attrs = u.attributes or {}\n"
        "attrs['must_change_password'] = bool(must_change)\n"
        "u.attributes = attrs\n"
        "u.save()\n"
        "g = Group.objects.filter(name='authentik Admins').first()\n"
        "if g: u.ak_groups.add(g)\n"
        "print('USER_OK' if created else 'USER_UPDATED', "
        "'admin_group=', g is not None, "
        "'must_change=', attrs['must_change_password'], "
        "'check=', u.check_password(os.environ['AK_PASSWORD']))\n"
    )

    # Retry avec backoff (5 tentatives, 10s entre chaque) — la 1ère échoue
    # parfois sur "ProgrammingError: relation 'authentik_core_user' does not exist"
    # ou sur conflit avec la création concurrente de l'outpost user.
    last_stdout = ""
    last_stderr = ""
    last_returncode = -1
    for attempt in range(5):
        try:
            out = subprocess.run(
                ["docker", "exec",
                 "-e", f"AK_USERNAME={username}",
                 "-e", f"AK_FULLNAME={fullname}",
                 "-e", f"AK_EMAIL={email}",
                 "-e", f"AK_PASSWORD={password}",
                 "-e", f"AK_MUST_CHANGE_PWD={'1' if is_default_pwd else '0'}",
                 "aibox-authentik-server", "ak", "shell", "-c", script],
                capture_output=True, text=True, timeout=45,
            )
            last_stdout = out.stdout
            last_stderr = out.stderr
            last_returncode = out.returncode
            # Log côté server pour debug post-mortem (visible dans docker logs)
            print(f"[create-admin-user] attempt={attempt+1} rc={out.returncode} "
                  f"stdout-tail={out.stdout[-150:]!r} "
                  f"stderr-tail={out.stderr[-150:]!r}", flush=True)
            if "USER_OK" in out.stdout or "USER_UPDATED" in out.stdout:
                return {"created": True,
                        "attempt": attempt + 1,
                        "must_change_password": is_default_pwd,
                        "stdout": out.stdout[-300:]}
        except subprocess.TimeoutExpired:
            last_stderr = "timeout après 45s"
            print(f"[create-admin-user] attempt={attempt+1} TIMEOUT", flush=True)
        if attempt < 4:
            _t.sleep(10)  # backoff avant retry

    # 5 retries échoués → erreur HTTP claire avec stderr complet (au lieu
    # de retourner created:false ou une erreur silencieuse). Le frontend
    # doit STOPPER ici, pas continuer avec provision-sso.
    raise HTTPException(
        500,
        detail={
            "error": "create_admin_failed",
            "message": "Création de l'admin Authentik échouée après 5 tentatives. "
                       "Vérifier que aibox-authentik-server est healthy et que .env "
                       "contient ADMIN_USERNAME / ADMIN_PASSWORD valides.",
            "returncode": last_returncode,
            "stdout_tail": last_stdout[-400:],
            "stderr_tail": last_stderr[-400:],
        },
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
                # --build : pour services/app, le code source est build localement
                # à partir du repo. Sans --build, on ressuscite l'image périmée
                # entre 2 reset/install (l'image cache contient potentiellement
                # une version du code qui ne sait pas lire les nouvelles vars
                # OIDC ou autres). Sur open_webui, l'image est pull (pas build),
                # le flag est sans effet.
                subprocess.run(
                    ["docker", "compose", "--env-file", "/srv/ai-stack/.env",
                     "up", "-d", "--build"],
                    cwd=compose_dir,
                    capture_output=True, timeout=300,
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
    """Marque la box comme configurée et passe la main à l'edge Caddy.

    Le hand-off est délicat : tant que `aibox-setup-caddy` tient le port
    80, `aibox-edge-caddy` ne peut pas démarrer (port collision). On le
    fait en background après avoir répondu, pour que le client reçoive
    bien sa confirmation finale.
    """
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text("configured\n")
    # Démarre une tâche détachée qui fait la transition
    # (docker stop wizard → start edge-caddy → écrit le marker host)
    subprocess.Popen(
        ["python3", "-c", _HANDOFF_SCRIPT],
        env={**os.environ},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"configured": True, "handoff": "scheduled"}


# Script Python exécuté en sous-process détaché pour faire la transition
# wizard → edge sans bloquer la réponse au client. Utilise les commandes
# Docker disponibles via /var/run/docker.sock (déjà monté dans setup-api).
_HANDOFF_SCRIPT = r"""
import subprocess, time
# 2 s de marge pour que le client reçoive la 200 OK
time.sleep(2)
# 1. Mark .configured côté HÔTE (pour ConditionPathExists du firstrun.service).
#    On passe par un container temporaire qui bind-mount /var/lib/aibox.
subprocess.run([
    "docker", "run", "--rm",
    "-v", "/var/lib/aibox:/h",
    "alpine:3.20", "sh", "-c", "mkdir -p /h && touch /h/.configured",
], timeout=30, check=False)
# 2. Stop le wizard (libère le port 80). aibox-setup-api se suicidera
#    avec son sibling — pas grave, la réponse est déjà partie.
subprocess.run(["docker", "stop", "aibox-setup-caddy"], timeout=30, check=False)
# 3. Démarre edge-caddy avec --force-recreate :
#    install.sh ne démarre plus edge (port 80 occupé par setup-caddy à
#    ce moment-là), donc c'est ICI que le container est créé pour la 1re
#    fois. --force-recreate garantit que tous les networks déclarés dans
#    le compose (aibox_net + ollama_net) sont bien attachés. Sans ça, un
#    container pré-existant (cas des cycles reset) garde son ancienne
#    config réseau et ne peut pas résoudre aibox-authentik-server.
subprocess.run(
    ["docker", "compose", "--env-file", "/srv/ai-stack/.env",
     "up", "-d", "--force-recreate"],
    cwd="/srv/ai-stack/services/edge",
    timeout=120, check=False,
)
# 4. Stop setup-api (nous-mêmes). Le service systemd a Condition !configured,
#    donc il ne se relancera plus.
subprocess.run(["docker", "stop", "aibox-setup-api"], timeout=30, check=False)
"""


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
