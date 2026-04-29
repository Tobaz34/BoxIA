"""
Gestion de parc — health-check + mises à jour OTA des clients.

Endpoints (à monter dans main.py) :
  POST /api/clients/{id}/update      lance ./update.sh sur la box (background)
  POST /api/clients/{id}/rollback    restore le dernier backup
  GET  /api/clients/{id}/health      ping ssh + état services
  GET  /api/fleet/overview           vue agrégée du parc
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

import paramiko

# Ces imports viennent de main.py — montés via dependency injection
log = logging.getLogger("fleet")

router = APIRouter(prefix="/api", tags=["fleet"])


async def _ssh_run(host: str, user: str, key_path: str, cmd: str) -> tuple[int, str]:
    """Exécute une commande SSH et retourne (exit_code, output)."""
    def _run():
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            pkey = paramiko.Ed25519Key.from_private_key_file(key_path)
        except paramiko.SSHException:
            pkey = paramiko.RSAKey.from_private_key_file(key_path)
        client.connect(hostname=host, username=user, pkey=pkey, timeout=15, look_for_keys=True)
        try:
            stdin, stdout, stderr = client.exec_command(cmd, timeout=600)
            out = stdout.read().decode(errors="replace")
            err = stderr.read().decode(errors="replace")
            rc = stdout.channel.recv_exit_status()
            return rc, out + err
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


def register_routes(app, engine, ssh_key_path: str, current_user, broker, Client):
    """Appelé depuis main.py pour brancher les routes fleet."""

    @app.post("/api/clients/{client_id}/update")
    async def update_client(client_id: int, _: str = Depends(current_user)) -> dict:
        with Session(engine) as s:
            c = s.get(Client, client_id)
            if not c:
                raise HTTPException(404, "Client introuvable")
            host, user = c.server_ip, c.server_user

        async def run():
            broker.emit(client_id, f"=== Update started @ {datetime.now(timezone.utc)} ===")
            try:
                rc, out = await _ssh_run(
                    host, user, ssh_key_path,
                    "cd /srv/ai-stack && ./update.sh 2>&1",
                )
                for line in out.splitlines():
                    broker.emit(client_id, line)
                broker.emit(client_id, f"=== Update finished (rc={rc}) ===")
            except Exception as e:
                broker.emit(client_id, f"FAILED: {e}")

        asyncio.create_task(run())
        return {"ok": True, "log_ws": f"/api/clients/{client_id}/logs"}

    @app.post("/api/clients/{client_id}/rollback")
    async def rollback_client(client_id: int, stamp: str | None = None,
                              _: str = Depends(current_user)) -> dict:
        with Session(engine) as s:
            c = s.get(Client, client_id)
            if not c:
                raise HTTPException(404, "Client introuvable")
            host, user = c.server_ip, c.server_user

        cmd = (
            "cd /srv/ai-stack && "
            f"./backup.sh restore {stamp}" if stamp else
            "cd /srv/ai-stack && ./backup.sh restore $(ls /srv/aibox-backups | tail -1)"
        )

        async def run():
            broker.emit(client_id, f"=== Rollback @ {datetime.now(timezone.utc)} ===")
            rc, out = await _ssh_run(host, user, ssh_key_path, cmd)
            for line in out.splitlines():
                broker.emit(client_id, line)
            broker.emit(client_id, f"=== Rollback finished (rc={rc}) ===")

        asyncio.create_task(run())
        return {"ok": True}

    @app.get("/api/clients/{client_id}/health")
    async def client_health(client_id: int, _: str = Depends(current_user)) -> dict:
        with Session(engine) as s:
            c = s.get(Client, client_id)
            if not c:
                raise HTTPException(404, "Client introuvable")
            host, user = c.server_ip, c.server_user

        try:
            rc, out = await _ssh_run(
                host, user, ssh_key_path,
                "docker ps --format '{{.Names}}\\t{{.Status}}' | head -50",
            )
            containers = []
            for line in out.splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    containers.append({"name": parts[0], "status": parts[1]})
            return {
                "ssh_ok": rc == 0,
                "containers": containers,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            return {"ssh_ok": False, "error": str(e),
                    "checked_at": datetime.now(timezone.utc).isoformat()}

    @app.get("/api/fleet/overview")
    async def fleet_overview(_: str = Depends(current_user)) -> dict:
        with Session(engine) as s:
            clients = list(s.exec(select(Client)).all())
        out: list[dict[str, Any]] = []
        # Health-check parallèle (timeout 5s par client)
        async def check(c: Any) -> dict:
            try:
                rc, _o = await asyncio.wait_for(
                    _ssh_run(c.server_ip, c.server_user, ssh_key_path, "echo ok"),
                    timeout=5,
                )
                online = rc == 0
            except Exception:
                online = False
            return {
                "id": c.id, "name": c.name, "domain": c.domain,
                "status": c.status, "online": online,
                "deployed_at": c.deployed_at.isoformat() if c.deployed_at else None,
            }
        out = await asyncio.gather(*[check(c) for c in clients])
        return {
            "total": len(out),
            "deployed": sum(1 for c in out if c["status"] == "deployed"),
            "online": sum(1 for c in out if c["online"]),
            "clients": out,
        }
