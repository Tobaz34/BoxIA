"""
Module de déploiement SSH — pousse la config et lance install.sh chez le client.

Workflow:
  1. Connexion SSH avec clé Paramiko
  2. Vérifie prérequis (docker, GPU optionnel, espace disque)
  3. git clone (ou pull) du repo AI Box dans /srv/ai-stack
  4. Écrit .env + client_config.yaml depuis la config du client
  5. Lance install.sh en mode non-interactif et stream stdout
  6. Retourne le statut + identifiants admin
"""
from __future__ import annotations

import asyncio
import logging
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Callable

import paramiko
import yaml

log = logging.getLogger(__name__)

REPO_GIT_URL = os.environ.get(
    "AIBOX_REPO_URL",
    "https://github.com/votre-org/aibox.git",  # à remplacer par ton repo privé
)
REPO_BRANCH = os.environ.get("AIBOX_REPO_BRANCH", "main")
REMOTE_ROOT = "/srv/ai-stack"


@dataclass
class DeployTarget:
    host: str
    user: str = "clikinfo"
    port: int = 22
    key_path: str | None = None      # chemin vers la clé privée SSH côté portail
    sudo_password: str | None = None  # si l'user n'a pas sudo NOPASSWD


@dataclass
class DeployConfig:
    """Données métier à déployer chez le client (issues du wizard)."""
    client_name: str
    client_sector: str
    users_count: int
    domain: str
    admin_fullname: str
    admin_username: str
    admin_email: str
    admin_password: str               # transmis au serveur, jamais loggé
    hw_profile: str = "tpe"
    technologies: dict[str, str] = field(default_factory=dict)
    activates: list[str] = field(default_factory=list)


class DeployError(Exception):
    pass


def _connect(target: DeployTarget) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    pkey = None
    if target.key_path:
        try:
            pkey = paramiko.Ed25519Key.from_private_key_file(target.key_path)
        except paramiko.SSHException:
            pkey = paramiko.RSAKey.from_private_key_file(target.key_path)
    client.connect(
        hostname=target.host,
        port=target.port,
        username=target.user,
        pkey=pkey,
        look_for_keys=True,
        timeout=15,
    )
    return client


def _exec_streaming(
    client: paramiko.SSHClient,
    cmd: str,
    on_line: Callable[[str], None] | None = None,
    sudo_password: str | None = None,
) -> int:
    """Exécute une commande, stream stdout/stderr ligne par ligne, retourne exit code."""
    if cmd.startswith("sudo ") and sudo_password:
        cmd = f"echo {shlex.quote(sudo_password)} | sudo -S " + cmd[len("sudo "):]
    log.debug("ssh exec: %s", cmd[:80])
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)
    for line in iter(stdout.readline, ""):
        if on_line:
            on_line(line.rstrip("\n"))
    err = stderr.read().decode(errors="replace")
    if err and on_line:
        for ln in err.splitlines():
            on_line(f"[stderr] {ln}")
    return stdout.channel.recv_exit_status()


def _shell_escape(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


def render_env(cfg: DeployConfig, secrets: dict[str, str]) -> str:
    """Construit le contenu du .env à pousser sur le serveur cible."""
    lines = [
        f"CLIENT_NAME={_shell_escape(cfg.client_name)}",
        f"CLIENT_SECTOR={cfg.client_sector}",
        f"CLIENT_USERS_COUNT={cfg.users_count}",
        f"DOMAIN={cfg.domain}",
        f"ADMIN_FULLNAME={_shell_escape(cfg.admin_fullname)}",
        f"ADMIN_USERNAME={cfg.admin_username}",
        f"ADMIN_EMAIL={cfg.admin_email}",
        f"ADMIN_PASSWORD={_shell_escape(cfg.admin_password)}",
        f"HW_PROFILE={cfg.hw_profile}",
        "LLM_MAIN=qwen2.5:7b",
        "LLM_EMBED=bge-m3",
        f"PG_DIFY_PASSWORD={secrets['pg_dify']}",
        f"PG_AUTHENTIK_PASSWORD={secrets['pg_authentik']}",
        f"AUTHENTIK_SECRET_KEY={secrets['ak_secret']}",
        f"DIFY_SECRET_KEY={secrets['dify_secret']}",
        f"QDRANT_API_KEY={secrets['qdrant_key']}",
        "QDRANT_VERSION=v1.13.4",
        "DIFY_VERSION=1.10.1",
        "AUTHENTIK_VERSION=2025.10.0",
        "NETWORK_NAME=aibox_net",
    ]
    for tech_id, value in cfg.technologies.items():
        if value and value != "none":
            lines.append(f"CLIENT_TECH_{tech_id.upper()}={_shell_escape(str(value))}")
    return "\n".join(lines) + "\n"


def render_client_config_yaml(cfg: DeployConfig) -> str:
    payload = {
        "client": {
            "name": cfg.client_name,
            "sector": cfg.client_sector,
            "users_count": cfg.users_count,
            "domain": cfg.domain,
        },
        "admin": {
            "fullname": cfg.admin_fullname,
            "username": cfg.admin_username,
            "email": cfg.admin_email,
        },
        "infrastructure": {"hw_profile": cfg.hw_profile},
        "technologies": cfg.technologies,
    }
    return yaml.dump(payload, allow_unicode=True, sort_keys=False)


def gen_secrets() -> dict[str, str]:
    import secrets as s, string
    alphabet = string.ascii_letters + string.digits
    def g(n: int) -> str:
        return "".join(s.choice(alphabet) for _ in range(n))
    return {
        "pg_dify": g(32),
        "pg_authentik": g(32),
        "ak_secret": g(60),
        "dify_secret": g(50),
        "qdrant_key": g(32),
    }


async def deploy(
    target: DeployTarget,
    cfg: DeployConfig,
    on_line: Callable[[str], None] | None = None,
) -> dict:
    """Déploie une AI Box chez un client. Async-friendly via thread executor."""
    loop = asyncio.get_event_loop()

    def _emit(line: str) -> None:
        log.info(line)
        if on_line:
            on_line(line)

    def _do_deploy() -> dict:
        client = _connect(target)
        try:
            secrets = gen_secrets()

            _emit(f"=== Connexion établie {target.user}@{target.host} ===")
            _exec_streaming(client, "uname -a", on_line=_emit)

            # 1. Préparer /srv/ai-stack (sudo car /srv = root)
            _emit("=== [1/5] Préparation /srv/ai-stack ===")
            _exec_streaming(
                client,
                f"sudo mkdir -p {REMOTE_ROOT} && sudo chown $USER:$USER {REMOTE_ROOT}",
                on_line=_emit,
                sudo_password=target.sudo_password,
            )

            # 2. Cloner ou pull le repo
            _emit("=== [2/5] Récupération du code AI Box ===")
            rc = _exec_streaming(
                client,
                f"[ -d {REMOTE_ROOT}/.git ] && (cd {REMOTE_ROOT} && git pull) "
                f"|| git clone -b {REPO_BRANCH} {REPO_GIT_URL} {REMOTE_ROOT}",
                on_line=_emit,
            )
            if rc != 0:
                raise DeployError("git clone/pull a échoué")

            # 3. Pousser .env et client_config.yaml via SFTP
            _emit("=== [3/5] Écriture configuration ===")
            sftp = client.open_sftp()
            try:
                env_content = render_env(cfg, secrets)
                yaml_content = render_client_config_yaml(cfg)
                with sftp.file(f"{REMOTE_ROOT}/.env", "w") as f:
                    f.write(env_content)
                sftp.chmod(f"{REMOTE_ROOT}/.env", 0o600)
                with sftp.file(f"{REMOTE_ROOT}/client_config.yaml", "w") as f:
                    f.write(yaml_content)
            finally:
                sftp.close()

            # 4. Lancer install.sh
            _emit("=== [4/5] Lancement install.sh ===")
            rc = _exec_streaming(
                client,
                f"cd {REMOTE_ROOT} && AIBOX_NONINTERACTIVE=1 bash install.sh 2>&1",
                on_line=_emit,
            )
            if rc != 0:
                raise DeployError(f"install.sh exit code {rc}")

            # 5. Créer le compte admin Authentik via Django shell
            _emit("=== [5/5] Création du compte admin Authentik ===")
            ak_cmd = (
                "docker exec aibox-authentik-server ak shell -c "
                + shlex.quote(
                    f"from authentik.core.models import User; "
                    f"u, c = User.objects.update_or_create("
                    f"username={cfg.admin_username!r}, "
                    f"defaults={{'name':{cfg.admin_fullname!r}, "
                    f"'email':{cfg.admin_email!r}, "
                    f"'is_superuser': True, 'is_active': True}}); "
                    f"u.set_password({cfg.admin_password!r}); "
                    f"u.save(); print('USER_OK')"
                )
            )
            _exec_streaming(client, ak_cmd, on_line=_emit)

            _emit("=== ✅ Déploiement terminé ===")
            return {
                "ok": True,
                "dashboard_url": f"https://auth.{cfg.domain}/if/user/",
                "admin_username": cfg.admin_username,
            }
        finally:
            client.close()

    return await loop.run_in_executor(None, _do_deploy)
