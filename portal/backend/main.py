"""
Portail de provisioning AI Box — Backend FastAPI v0.2.

Endpoints :
  - GET  /                                health
  - POST /api/auth/login                  login admin (mdp + retourne JWT en cookie)
  - POST /api/auth/logout
  - GET  /api/auth/me                     vérifie session
  - GET  /api/questionnaire               questionnaire essentiel
  - GET  /api/questionnaire?full=true     questionnaire complet 56 items
  - CRUD /api/clients
  - POST /api/clients/{id}/deploy         lance le déploiement async (Paramiko)
  - WS   /api/clients/{id}/logs           stream live des logs de déploiement
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import (
    Cookie, Depends, FastAPI, HTTPException, Request, Response, WebSocket,
    WebSocketDisconnect, status,
)
from fastapi.middleware.cors import CORSMiddleware
from itsdangerous import BadSignature, TimestampSigner
from pydantic import BaseModel, EmailStr
from sqlmodel import Field, Session, SQLModel, create_engine, select

from deploy import DeployConfig, DeployTarget, deploy as run_deploy
from fleet import register_routes as register_fleet_routes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("portal")

# ---- Config ----
REPO_ROOT = Path(__file__).resolve().parents[2]
QUESTIONNAIRE_FULL = REPO_ROOT / "config" / "questionnaire.yaml"
QUESTIONNAIRE_ESSENTIALS = REPO_ROOT / "config" / "questionnaire-essentials.yaml"
DB_PATH = Path(__file__).resolve().parent / "portal.db"
SESSION_SECRET = os.environ.get("SESSION_SECRET", "change-me-in-prod-32-chars-min!")
SESSION_TTL_DAYS = 7
ADMIN_USER = os.environ.get("PORTAL_ADMIN_USER", "admin")
# Hash argon2 du mdp ; à régénérer en prod : python -c "from argon2 import PasswordHasher; print(PasswordHasher().hash('TONMDP'))"
ADMIN_PASSWORD_HASH = os.environ.get(
    "PORTAL_ADMIN_PASSWORD_HASH",
    PasswordHasher().hash("changeme"),
)
SSH_KEY_PATH = os.environ.get("PORTAL_SSH_KEY_PATH", str(Path.home() / ".ssh" / "id_ed25519"))

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)
signer = TimestampSigner(SESSION_SECRET)
hasher = PasswordHasher()


# ---- Modèles DB ----
class Client(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    sector: str
    users_count: int
    domain: str
    admin_fullname: str = ""
    admin_username: str = ""
    admin_email: str = ""
    admin_password: str = ""        # plaintext temporaire — wiped après déploiement
    server_ip: str
    server_user: str = "clikinfo"
    server_sudo_pwd: str = ""        # idem, wiped après déploiement
    hw_profile: str = "tpe"
    technologies: str = "{}"          # JSON
    config_yaml: str | None = None
    deployed_at: datetime | None = None
    status: str = "draft"             # draft | deploying | deployed | failed
    last_error: str | None = None


class ClientCreate(BaseModel):
    name: str
    sector: str
    users_count: int = 10
    domain: str
    admin_fullname: str
    admin_username: str
    admin_email: EmailStr
    admin_password: str
    server_ip: str
    server_user: str = "clikinfo"
    server_sudo_pwd: str = ""
    hw_profile: str = "tpe"
    technologies: dict[str, Any] = {}


class ClientUpdate(BaseModel):
    name: str | None = None
    sector: str | None = None
    users_count: int | None = None
    domain: str | None = None
    technologies: dict[str, Any] | None = None


class LoginPayload(BaseModel):
    username: str
    password: str


# ---- App ----
app = FastAPI(title="AI Box Portal", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    SQLModel.metadata.create_all(engine)
    # Routes fleet (update, rollback, health, overview)
    register_fleet_routes(app, engine, SSH_KEY_PATH, current_user, broker, Client)


# ---- Auth helpers ----
def _make_session_cookie(username: str) -> str:
    return signer.sign(username.encode()).decode()


def current_user(session: str | None = Cookie(default=None)) -> str:
    if not session:
        raise HTTPException(401, "Non authentifié")
    try:
        max_age = int(timedelta(days=SESSION_TTL_DAYS).total_seconds())
        username = signer.unsign(session, max_age=max_age).decode()
        return username
    except BadSignature:
        raise HTTPException(401, "Session invalide")


# ---- Logs broker (in-memory ring buffer + queues per client) ----
class LogBroker:
    """Stocke les N derniers logs par client_id et notifie les WS connectés."""

    def __init__(self, ring_size: int = 500) -> None:
        self.ring_size = ring_size
        self.buffers: dict[int, deque[str]] = {}
        self.queues: dict[int, list[asyncio.Queue]] = {}

    def emit(self, client_id: int, line: str) -> None:
        buf = self.buffers.setdefault(client_id, deque(maxlen=self.ring_size))
        buf.append(line)
        for q in self.queues.get(client_id, []):
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                pass

    def history(self, client_id: int) -> list[str]:
        return list(self.buffers.get(client_id, []))

    def subscribe(self, client_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.queues.setdefault(client_id, []).append(q)
        return q

    def unsubscribe(self, client_id: int, q: asyncio.Queue) -> None:
        if client_id in self.queues and q in self.queues[client_id]:
            self.queues[client_id].remove(q)


broker = LogBroker()


# ---- Routes : système ----
@app.get("/")
def health() -> dict:
    return {"status": "ok", "service": "aibox-portal", "version": "0.2.0"}


# ---- Routes : auth ----
@app.post("/api/auth/login")
def login(payload: LoginPayload, response: Response) -> dict:
    if payload.username != ADMIN_USER:
        raise HTTPException(401, "Identifiant ou mot de passe invalide")
    try:
        hasher.verify(ADMIN_PASSWORD_HASH, payload.password)
    except VerifyMismatchError:
        raise HTTPException(401, "Identifiant ou mot de passe invalide")
    cookie_value = _make_session_cookie(payload.username)
    response.set_cookie(
        "session", cookie_value,
        max_age=int(timedelta(days=SESSION_TTL_DAYS).total_seconds()),
        httponly=True, samesite="lax",
    )
    return {"ok": True, "user": payload.username}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict:
    response.delete_cookie("session")
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: str = Depends(current_user)) -> dict:
    return {"user": user}


# ---- Routes : questionnaire ----
@app.get("/api/questionnaire")
def get_questionnaire(full: bool = False) -> dict:
    path = QUESTIONNAIRE_FULL if full else QUESTIONNAIRE_ESSENTIALS
    if not path.exists():
        raise HTTPException(500, f"Questionnaire introuvable: {path}")
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---- Routes : clients ----
@app.get("/api/clients")
def list_clients(_: str = Depends(current_user)) -> list[Client]:
    with Session(engine) as s:
        return list(s.exec(select(Client)).all())


@app.post("/api/clients", status_code=201)
def create_client(payload: ClientCreate, _: str = Depends(current_user)) -> Client:
    import json
    client = Client(
        **payload.model_dump(exclude={"technologies"}),
        technologies=json.dumps(payload.technologies),
    )
    with Session(engine) as s:
        s.add(client)
        s.commit()
        s.refresh(client)
    return client


@app.get("/api/clients/{client_id}")
def get_client(client_id: int, _: str = Depends(current_user)) -> Client:
    with Session(engine) as s:
        c = s.get(Client, client_id)
        if not c:
            raise HTTPException(404, "Client introuvable")
        return c


@app.patch("/api/clients/{client_id}")
def update_client(client_id: int, payload: ClientUpdate, _: str = Depends(current_user)) -> Client:
    import json
    with Session(engine) as s:
        c = s.get(Client, client_id)
        if not c:
            raise HTTPException(404, "Client introuvable")
        data = payload.model_dump(exclude_unset=True)
        if "technologies" in data:
            c.technologies = json.dumps(data.pop("technologies"))
        for k, v in data.items():
            setattr(c, k, v)
        s.add(c); s.commit(); s.refresh(c)
        return c


@app.delete("/api/clients/{client_id}")
def delete_client(client_id: int, _: str = Depends(current_user)) -> dict:
    with Session(engine) as s:
        c = s.get(Client, client_id)
        if not c:
            raise HTTPException(404, "Client introuvable")
        s.delete(c); s.commit()
    return {"ok": True}


# ---- Déploiement ----
@app.post("/api/clients/{client_id}/deploy")
async def deploy_client(client_id: int, _: str = Depends(current_user)) -> dict:
    import json
    with Session(engine) as s:
        c = s.get(Client, client_id)
        if not c:
            raise HTTPException(404, "Client introuvable")
        c.status = "deploying"
        c.last_error = None
        s.add(c); s.commit(); s.refresh(c)

    # Démarre la tâche de déploiement en arrière-plan
    asyncio.create_task(_run_deploy(client_id))
    return {"client_id": client_id, "status": "deploying"}


async def _run_deploy(client_id: int) -> None:
    import json
    with Session(engine) as s:
        c = s.get(Client, client_id)
        if not c:
            return
        target = DeployTarget(
            host=c.server_ip,
            user=c.server_user,
            key_path=SSH_KEY_PATH,
            sudo_password=c.server_sudo_pwd or None,
        )
        cfg = DeployConfig(
            client_name=c.name,
            client_sector=c.sector,
            users_count=c.users_count,
            domain=c.domain,
            admin_fullname=c.admin_fullname,
            admin_username=c.admin_username,
            admin_email=c.admin_email,
            admin_password=c.admin_password,
            hw_profile=c.hw_profile,
            technologies=json.loads(c.technologies or "{}"),
        )

    def emit(line: str) -> None:
        broker.emit(client_id, line)

    try:
        result = await run_deploy(target, cfg, on_line=emit)
        with Session(engine) as s:
            cc = s.get(Client, client_id)
            if cc:
                cc.status = "deployed"
                cc.deployed_at = datetime.now(timezone.utc)
                # Wipe les credentials maintenant qu'on n'en a plus besoin
                cc.admin_password = ""
                cc.server_sudo_pwd = ""
                s.add(cc); s.commit()
        emit(f"DEPLOYED url={result.get('dashboard_url')}")
    except Exception as e:  # noqa: BLE001
        log.exception("deploy failed")
        with Session(engine) as s:
            cc = s.get(Client, client_id)
            if cc:
                cc.status = "failed"
                cc.last_error = str(e)
                s.add(cc); s.commit()
        emit(f"FAILED: {e}")


@app.websocket("/api/clients/{client_id}/logs")
async def deploy_logs(ws: WebSocket, client_id: int):
    await ws.accept()
    # Replay l'historique d'abord
    for line in broker.history(client_id):
        try:
            await ws.send_text(line)
        except Exception:
            return
    q = broker.subscribe(client_id)
    try:
        while True:
            line = await q.get()
            await ws.send_text(line)
    except WebSocketDisconnect:
        pass
    finally:
        broker.unsubscribe(client_id, q)
