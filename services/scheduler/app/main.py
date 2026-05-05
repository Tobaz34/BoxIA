"""AI Box — Scheduler service.

P1 #6 du plan v2 OSS-inspired (cf tools/research/00_SYNTHESE.md +
audit_P0_05_replan.md). Exposera plus tard 3 tools côté Concierge
(`schedule_task`/`stop_schedule`/`list_schedules`) qui POST sur ces
endpoints.

API REST :
- POST /v1/schedules           crée un job (cron ou interval)
- GET  /v1/schedules           liste les jobs (filtre par user_id)
- GET  /v1/schedules/<id>      détail d'un job + dernière exécution
- DELETE /v1/schedules/<id>    annule + retire le job

Auth : Bearer AGENTS_API_KEY pour TOUS les endpoints.

Persistance : SQLAlchemy + SQLite local /data/scheduler.db (D2 décision
filesystem JSONL/SQLite, pas Postgres). APScheduler utilise le même
SQLite comme JobStore pour survivre aux restarts container.

Action types supportés (V1) :
- "http_post" — POST sur une URL avec body JSON (généraliste)
- "agent_message" — appelle /api/chat aibox-app avec {agent, query}
- "n8n_workflow" — déclenche un workflow n8n par webhook
- "tool_call" — POST direct sur /api/agents-tools/<name>
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from datetime import datetime
from typing import Any, Optional

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query, status
from pydantic import BaseModel, Field, field_validator

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("scheduler")

API_KEY = os.environ.get("AGENTS_API_KEY", "")
DB_PATH = os.environ.get("SCHEDULER_DB_PATH", "/data/scheduler.db")
AIBOX_APP_URL = os.environ.get("AIBOX_APP_URL", "http://host.docker.internal:3100")
MAX_JOBS_PER_USER = int(os.environ.get("MAX_JOBS_PER_USER", "20"))
TZ = os.environ.get("TZ", "Europe/Paris")

# ---------------------------------------------------------------------------
# Modèles Pydantic
# ---------------------------------------------------------------------------


class ActionSpec(BaseModel):
    """Définit l'action à exécuter quand le job se déclenche."""

    type: str = Field(..., description="http_post | agent_message | n8n_workflow | tool_call")
    # Pour http_post : url + method + body
    url: Optional[str] = None
    method: Optional[str] = "POST"
    body: Optional[dict[str, Any]] = None
    # Pour agent_message : slug agent + query
    agent_slug: Optional[str] = None
    query: Optional[str] = None
    # Pour tool_call : nom du tool
    tool_name: Optional[str] = None
    tool_args: Optional[dict[str, Any]] = None
    # Headers additionnels pour http_post
    headers: Optional[dict[str, str]] = None

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        allowed = {"http_post", "agent_message", "n8n_workflow", "tool_call"}
        if v not in allowed:
            raise ValueError(f"action.type must be one of {allowed}")
        return v


class TriggerSpec(BaseModel):
    """Définit quand le job se déclenche.

    Soit cron (expression cron Linux 5-field), soit interval (secondes).
    Exclusivement l'un ou l'autre, pas les deux.
    """

    cron: Optional[str] = Field(
        None, description="Cron expression 5-field, ex '0 8 * * 1-5' (lundi-vendredi 8h)"
    )
    interval_seconds: Optional[int] = Field(
        None, ge=60, le=86400 * 30, description="Intervalle en secondes (min 60s, max 30j)"
    )

    @field_validator("cron")
    @classmethod
    def validate_cron(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        parts = v.strip().split()
        if len(parts) != 5:
            raise ValueError("cron must be 5-field (minute hour day month dow)")
        return v.strip()


class CreateScheduleRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=1000)
    user_id: str = Field(..., description="Email NextAuth du user propriétaire")
    trigger: TriggerSpec
    action: ActionSpec
    enabled: bool = True


class ScheduleResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    user_id: str
    trigger: TriggerSpec
    action: ActionSpec
    enabled: bool
    created_at: str
    next_run_at: Optional[str] = None
    last_run_at: Optional[str] = None
    last_run_status: Optional[str] = None
    last_run_error: Optional[str] = None


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------


def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_KEY:
        log.error("AGENTS_API_KEY non configuré — refus systématique")
        raise HTTPException(status_code=503, detail="server_misconfigured")
    expected = f"Bearer {API_KEY}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------------------
# Métadonnées schedules — table SQLite séparée (APScheduler garde son propre
# état dans `apscheduler_jobs` ; nous stockons les métadonnées métier user
# dans `boxia_schedules`).
# ---------------------------------------------------------------------------


def _ensure_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS boxia_schedules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                user_id TEXT NOT NULL,
                trigger_json TEXT NOT NULL,
                action_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT,
                last_run_error TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_boxia_schedules_user ON boxia_schedules(user_id)"
        )
        conn.commit()
    finally:
        conn.close()


def _save_schedule(req: CreateScheduleRequest, schedule_id: str) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO boxia_schedules
              (id, name, description, user_id, trigger_json, action_json,
               enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                schedule_id,
                req.name,
                req.description,
                req.user_id,
                req.trigger.model_dump_json(),
                req.action.model_dump_json(),
                1 if req.enabled else 0,
                datetime.utcnow().isoformat() + "Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _delete_schedule(schedule_id: str, user_id: Optional[str] = None) -> bool:
    conn = sqlite3.connect(DB_PATH)
    try:
        if user_id:
            cur = conn.execute(
                "DELETE FROM boxia_schedules WHERE id = ? AND user_id = ?",
                (schedule_id, user_id),
            )
        else:
            cur = conn.execute(
                "DELETE FROM boxia_schedules WHERE id = ?", (schedule_id,)
            )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _get_schedule(schedule_id: str) -> Optional[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            "SELECT * FROM boxia_schedules WHERE id = ?", (schedule_id,)
        )
        row = cur.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _list_schedules(user_id: Optional[str] = None) -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        if user_id:
            cur = conn.execute(
                "SELECT * FROM boxia_schedules WHERE user_id = ? ORDER BY created_at DESC",
                (user_id,),
            )
        else:
            cur = conn.execute(
                "SELECT * FROM boxia_schedules ORDER BY created_at DESC"
            )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _count_user_schedules(user_id: str) -> int:
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute(
            "SELECT COUNT(*) FROM boxia_schedules WHERE user_id = ?", (user_id,)
        )
        return cur.fetchone()[0]
    finally:
        conn.close()


def _record_run(
    schedule_id: str,
    status: str,
    error: Optional[str] = None,
) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            UPDATE boxia_schedules
            SET last_run_at = ?, last_run_status = ?, last_run_error = ?
            WHERE id = ?
            """,
            (
                datetime.utcnow().isoformat() + "Z",
                status,
                (error or "")[:500],
                schedule_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Job runner — exécute l'action quand APScheduler trigger
# ---------------------------------------------------------------------------


async def execute_action(schedule_id: str, action_json: str) -> None:
    """Appelé par APScheduler quand un job se déclenche.

    On reload la spec depuis le JSON (APScheduler sérialise les args) puis
    on dispatch selon `action.type`. Toutes les actions appellent
    aibox-app via HTTP — pas de logique métier ici, on est juste un trigger.
    """
    try:
        action = ActionSpec.model_validate_json(action_json)
    except Exception as e:
        log.error("schedule %s: action invalide: %s", schedule_id, e)
        _record_run(schedule_id, "error", f"invalid_action: {e}")
        return

    log.info("schedule %s trigger type=%s", schedule_id, action.type)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            if action.type == "http_post":
                if not action.url:
                    raise ValueError("http_post requires action.url")
                headers = {"Content-Type": "application/json"}
                if action.headers:
                    headers.update(action.headers)
                r = await client.request(
                    action.method or "POST",
                    action.url,
                    json=action.body or {},
                    headers=headers,
                )
                r.raise_for_status()

            elif action.type == "agent_message":
                if not action.agent_slug or not action.query:
                    raise ValueError("agent_message requires agent_slug + query")
                r = await client.post(
                    f"{AIBOX_APP_URL}/api/chat",
                    json={
                        "agent": action.agent_slug,
                        "query": action.query,
                    },
                    headers={
                        "Authorization": f"Bearer {API_KEY}",
                        "X-Scheduled-By": schedule_id,
                    },
                )
                r.raise_for_status()

            elif action.type == "tool_call":
                if not action.tool_name:
                    raise ValueError("tool_call requires tool_name")
                r = await client.post(
                    f"{AIBOX_APP_URL}/api/agents-tools/{action.tool_name}",
                    json=action.tool_args or {},
                    headers={
                        "Authorization": f"Bearer {API_KEY}",
                        "X-Scheduled-By": schedule_id,
                    },
                )
                r.raise_for_status()

            elif action.type == "n8n_workflow":
                if not action.url:
                    raise ValueError("n8n_workflow requires url (webhook)")
                r = await client.post(
                    action.url,
                    json=action.body or {},
                )
                r.raise_for_status()

            else:
                raise ValueError(f"unknown action type {action.type}")

        _record_run(schedule_id, "success", None)
        log.info("schedule %s run success", schedule_id)
    except Exception as e:
        msg = str(e)[:300]
        log.warning("schedule %s run failed: %s", schedule_id, msg)
        _record_run(schedule_id, "error", msg)


# ---------------------------------------------------------------------------
# FastAPI app + APScheduler
# ---------------------------------------------------------------------------

scheduler: AsyncIOScheduler = AsyncIOScheduler(
    jobstores={
        "default": SQLAlchemyJobStore(url=f"sqlite:///{DB_PATH}"),
    },
    timezone=TZ,
)

app = FastAPI(
    title="AI Box Scheduler",
    description="Scheduling service for BoxIA agents (P1 #6).",
    version="0.1.0",
)


@app.on_event("startup")
async def _startup() -> None:
    _ensure_db()
    scheduler.start()
    log.info("scheduler started — db=%s tz=%s", DB_PATH, TZ)


@app.on_event("shutdown")
async def _shutdown() -> None:
    scheduler.shutdown(wait=False)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "scheduler_running": scheduler.running,
        "jobs_count": len(scheduler.get_jobs()),
    }


def _build_trigger(spec: TriggerSpec):
    if spec.cron:
        return CronTrigger.from_crontab(spec.cron, timezone=TZ)
    if spec.interval_seconds:
        return IntervalTrigger(seconds=spec.interval_seconds)
    raise HTTPException(
        status_code=400, detail="trigger requires cron or interval_seconds"
    )


def _next_run(job_id: str) -> Optional[str]:
    job = scheduler.get_job(job_id)
    if job and job.next_run_time:
        return job.next_run_time.isoformat()
    return None


@app.post("/v1/schedules", response_model=ScheduleResponse, status_code=201)
async def create_schedule(
    req: CreateScheduleRequest,
    _auth: None = Depends(require_auth),
) -> ScheduleResponse:
    if _count_user_schedules(req.user_id) >= MAX_JOBS_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"user {req.user_id} has reached MAX_JOBS_PER_USER={MAX_JOBS_PER_USER}",
        )
    if not req.trigger.cron and not req.trigger.interval_seconds:
        raise HTTPException(
            status_code=400, detail="trigger requires cron or interval_seconds"
        )

    schedule_id = f"job_{int(datetime.utcnow().timestamp() * 1000)}_{req.user_id[:8]}"
    _save_schedule(req, schedule_id)

    trigger = _build_trigger(req.trigger)
    scheduler.add_job(
        execute_action,
        trigger=trigger,
        id=schedule_id,
        args=[schedule_id, req.action.model_dump_json()],
        replace_existing=True,
    )
    if not req.enabled:
        scheduler.pause_job(schedule_id)

    log.info("create schedule %s name=%s user=%s", schedule_id, req.name, req.user_id)
    return _to_response(_get_schedule(schedule_id), schedule_id)


@app.get("/v1/schedules")
async def list_schedules(
    user_id: Optional[str] = Query(default=None),
    _auth: None = Depends(require_auth),
) -> dict[str, Any]:
    rows = _list_schedules(user_id)
    return {
        "count": len(rows),
        "schedules": [_to_response(r, r["id"]).model_dump() for r in rows],
    }


@app.get("/v1/schedules/{schedule_id}", response_model=ScheduleResponse)
async def get_schedule(
    schedule_id: str = Path(...),
    _auth: None = Depends(require_auth),
) -> ScheduleResponse:
    row = _get_schedule(schedule_id)
    if not row:
        raise HTTPException(status_code=404, detail="schedule_not_found")
    return _to_response(row, schedule_id)


@app.delete("/v1/schedules/{schedule_id}", status_code=204)
async def delete_schedule(
    schedule_id: str = Path(...),
    user_id: Optional[str] = Query(default=None),
    _auth: None = Depends(require_auth),
) -> None:
    row = _get_schedule(schedule_id)
    if not row:
        raise HTTPException(status_code=404, detail="schedule_not_found")
    if user_id and row["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="forbidden_not_owner")

    try:
        scheduler.remove_job(schedule_id)
    except Exception:
        pass  # déjà retiré côté APScheduler
    _delete_schedule(schedule_id)
    log.info("delete schedule %s", schedule_id)


def _to_response(row: dict, job_id: str) -> ScheduleResponse:
    trigger = TriggerSpec.model_validate_json(row["trigger_json"])
    action = ActionSpec.model_validate_json(row["action_json"])
    return ScheduleResponse(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        user_id=row["user_id"],
        trigger=trigger,
        action=action,
        enabled=bool(row["enabled"]),
        created_at=row["created_at"],
        next_run_at=_next_run(job_id),
        last_run_at=row["last_run_at"],
        last_run_status=row["last_run_status"],
        last_run_error=row["last_run_error"],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
