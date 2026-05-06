"""AI Box — Sandbox d'exécution code (P0 #1).

Service Python qui exécute du code bash ou python soumis par les agents IA
(via le tool `bash_exec` côté Concierge), dans un environnement isolé
multi-couches :

1. Container runtime : gVisor (D1 décision) ou nsjail Plan B
2. Filesystem : root read-only, /tmp tmpfs noexec+nosuid+nodev,
   /tmp/work tmpfs writable mais limitée 256 MB
3. Network : disabled par défaut (override env SANDBOX_ALLOW_NETWORK)
4. Capabilities : ALL droppées, no-new-privileges
5. Resources : 512 MB RAM, 1 CPU, 64 PIDs max
6. Timeout : 30s default, 300s max (cap dur)
7. Auth : Bearer AGENTS_API_KEY

Endpoint POST /v1/exec :
  body { lang: "bash"|"python", code: str, timeout_seconds?: int,
         session_id?: str (path validé regex), env?: {VAR: VAL} (cap 10) }
  response { ok, stdout, stderr, exit_code, duration_ms,
             files_created: [{name, size}], stdout_truncated, stderr_truncated }

Référence : tools/research/audit_P0_01_sandbox.md +
            DECISIONS-P0.md §D1 (gVisor) + §D7 (is_sensitive_action).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("sandbox")

API_KEY = os.environ.get("AGENTS_API_KEY", "")
ALLOW_NETWORK = os.environ.get("SANDBOX_ALLOW_NETWORK", "false").lower() == "true"
MAX_TIMEOUT = int(os.environ.get("SANDBOX_MAX_TIMEOUT", "300"))
DEFAULT_TIMEOUT = int(os.environ.get("SANDBOX_DEFAULT_TIMEOUT", "30"))
WORK_BASE = Path(os.environ.get("SANDBOX_WORK_BASE", "/tmp/work"))

STDOUT_LIMIT = 64 * 1024  # 64 KB max output (au-delà → tronqué)
STDERR_LIMIT = 32 * 1024
SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,40}$")


# ---------------------------------------------------------------------------
# Modèles
# ---------------------------------------------------------------------------


class ExecRequest(BaseModel):
    lang: str = Field(..., description="bash | python")
    code: str = Field(..., min_length=1, max_length=128 * 1024)
    timeout_seconds: int = Field(default=DEFAULT_TIMEOUT, ge=1, le=MAX_TIMEOUT)
    # session_id permet de partager /tmp/work entre runs (ex: step 1 génère
    # un CSV, step 2 le lit). Si absent → workdir éphémère unique.
    session_id: Optional[str] = None
    # Env vars supplémentaires (max 10, valeur 4 KB max). On filtre les
    # secrets-style noms (PASSWORD/SECRET/TOKEN) — l'utilisateur ne devrait
    # JAMAIS passer un secret au sandbox.
    env: Optional[dict[str, str]] = None

    @field_validator("lang")
    @classmethod
    def validate_lang(cls, v: str) -> str:
        if v not in ("bash", "python"):
            raise ValueError("lang must be 'bash' or 'python'")
        return v

    @field_validator("session_id")
    @classmethod
    def validate_session(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not SESSION_ID_RE.match(v):
            raise ValueError("session_id must match [a-zA-Z0-9_-]{1,40}")
        return v

    @field_validator("env")
    @classmethod
    def validate_env(cls, v: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        if v is None:
            return v
        if len(v) > 10:
            raise ValueError("env max 10 entries")
        for k, val in v.items():
            if not re.match(r"^[A-Z_][A-Z0-9_]{0,40}$", k):
                raise ValueError(f"env key invalid: {k}")
            # Bloque les secrets évidents
            if any(p in k for p in ("PASSWORD", "SECRET", "TOKEN", "API_KEY", "PRIVATE")):
                raise ValueError(
                    f"env key {k} looks like a secret — sandbox refuse"
                )
            if not isinstance(val, str) or len(val) > 4096:
                raise ValueError(f"env value for {k} too large or not str")
        return v


class FileCreated(BaseModel):
    name: str
    size: int


class ExecResponse(BaseModel):
    ok: bool
    stdout: str
    stderr: str
    exit_code: Optional[int]
    duration_ms: int
    timed_out: bool = False
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    files_created: list[FileCreated] = []
    runtime_info: dict = Field(default_factory=dict)
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_KEY:
        log.error("AGENTS_API_KEY non configuré")
        raise HTTPException(status_code=503, detail="server_misconfigured")
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------------------
# Exec runtime
# ---------------------------------------------------------------------------


def _resolve_workdir(session_id: Optional[str]) -> tuple[Path, bool]:
    """Retourne (path, is_temp).

    Si session_id fourni → /tmp/work/<session_id> persistant pendant la
    durée de vie du container (tmpfs survit aux exec mais pas aux
    restarts). Sinon → mkdtemp éphémère, deleted après exec.
    """
    if session_id:
        wd = WORK_BASE / session_id
        wd.mkdir(parents=True, exist_ok=True)
        return wd, False
    # Ephemeral
    tmp = Path(tempfile.mkdtemp(prefix="exec_", dir=str(WORK_BASE)))
    return tmp, True


def _list_created_files(workdir: Path, before: set[Path]) -> list[FileCreated]:
    """Compare le contenu workdir avant/après pour détecter les fichiers
    créés par le code utilisateur (vs déjà présents en début de session)."""
    created: list[FileCreated] = []
    try:
        for p in workdir.rglob("*"):
            if p.is_file() and p not in before:
                try:
                    created.append(FileCreated(name=str(p.relative_to(workdir)), size=p.stat().st_size))
                except OSError:
                    pass
    except OSError:
        pass
    # Cap nb fichiers retournés (un script malveillant pourrait en créer 100k)
    return created[:50]


async def _run_proc(
    cmd: list[str],
    workdir: Path,
    env: dict[str, str],
    timeout_s: int,
) -> tuple[str, str, Optional[int], bool]:
    """Lance un subprocess avec timeout. Retourne (stdout, stderr, code, timed_out).

    On utilise asyncio + create_subprocess_exec pour n'avoir aucun shell
    intermédiaire (commande passée comme liste directe — pas d'injection
    shell possible côté wrapper). Le code utilisateur peut bien sûr lancer
    `os.system` ou `subprocess.run("...", shell=True)` dans son propre
    contexte, mais c'est le code utilisateur qui décide — pas notre
    responsabilité de wrapper.
    """
    timed_out = False
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(workdir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=timeout_s
        )
    except asyncio.TimeoutError:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            stdout_b, stderr_b = await proc.communicate()
        except Exception:
            stdout_b, stderr_b = b"", b""
    return (
        stdout_b.decode("utf-8", errors="replace"),
        stderr_b.decode("utf-8", errors="replace"),
        proc.returncode if not timed_out else None,
        timed_out,
    )


def _build_env(extra: Optional[dict[str, str]]) -> dict[str, str]:
    """Construit un env propre pour le subprocess.

    On NE PROPAGE PAS l'env du process scheduler (qui contient
    AGENTS_API_KEY et autres secrets) → on part d'un env minimal et on
    ajoute uniquement les variables sûres.
    """
    base = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/tmp/work",
        "PYTHONUNBUFFERED": "1",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    if extra:
        for k, v in extra.items():
            # _validate_env a déjà filtré les noms de secrets
            base[k] = v
    return base


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AI Box Sandbox",
    description="Code execution sandbox for BoxIA agents (P0 #1).",
    version="0.1.0",
)


@app.get("/healthz")
async def healthz() -> dict:
    runtime = "unknown"
    try:
        # gVisor laisse une signature dans /proc — heuristique imparfaite mais
        # utile pour confirmer qu'on tourne bien sur runsc.
        with open("/proc/version", "r") as f:
            content = f.read()
            if "gVisor" in content or "runsc" in content:
                runtime = "gvisor"
            else:
                runtime = "runc"
    except Exception:
        pass
    return {
        "ok": True,
        "runtime": runtime,
        "network_allowed": ALLOW_NETWORK,
        "max_timeout": MAX_TIMEOUT,
        "default_timeout": DEFAULT_TIMEOUT,
        "work_base": str(WORK_BASE),
    }


@app.post("/v1/exec", response_model=ExecResponse)
async def exec_code(
    req: ExecRequest,
    _auth: None = Depends(require_auth),
) -> ExecResponse:
    """Exécute du code bash ou python dans la sandbox.

    Workflow :
    1. Resolve workdir (/tmp/work/<session_id> ou ephemeral)
    2. Snapshot fichiers présents (pour détecter created)
    3. Écrit le code dans un fichier (script.sh / script.py)
    4. Lance subprocess avec timeout
    5. Capture stdout/stderr (cap 64 KB / 32 KB), exit_code
    6. Liste les fichiers créés
    7. Cleanup workdir si ephemeral
    """
    start = time.monotonic()
    workdir, is_temp = _resolve_workdir(req.session_id)

    # Snapshot avant
    try:
        files_before = {p for p in workdir.rglob("*") if p.is_file()}
    except OSError:
        files_before = set()

    # Écrit le script
    if req.lang == "bash":
        script_path = workdir / "script.sh"
        script_path.write_text(req.code, encoding="utf-8")
        cmd = ["bash", str(script_path)]
    else:  # python
        script_path = workdir / "script.py"
        script_path.write_text(req.code, encoding="utf-8")
        cmd = ["python", "-u", str(script_path)]

    env = _build_env(req.env)

    log.info(
        "exec lang=%s timeout=%ds workdir=%s session=%s",
        req.lang, req.timeout_seconds, workdir, req.session_id or "(ephemeral)",
    )

    try:
        stdout, stderr, code, timed_out = await _run_proc(
            cmd, workdir, env, req.timeout_seconds
        )
    except Exception as e:
        log.error("exec subprocess failed: %s", e)
        if is_temp:
            shutil.rmtree(workdir, ignore_errors=True)
        return ExecResponse(
            ok=False,
            stdout="",
            stderr="",
            exit_code=None,
            duration_ms=int((time.monotonic() - start) * 1000),
            error=f"subprocess_failed: {e}"[:200],
        )

    # Truncate outputs
    stdout_truncated = len(stdout) > STDOUT_LIMIT
    stderr_truncated = len(stderr) > STDERR_LIMIT
    if stdout_truncated:
        stdout = stdout[:STDOUT_LIMIT] + "\n[...stdout truncated...]"
    if stderr_truncated:
        stderr = stderr[:STDERR_LIMIT] + "\n[...stderr truncated...]"

    files_created = _list_created_files(workdir, files_before)

    # Cleanup ephemeral
    if is_temp:
        shutil.rmtree(workdir, ignore_errors=True)

    duration_ms = int((time.monotonic() - start) * 1000)
    return ExecResponse(
        ok=(code == 0 and not timed_out),
        stdout=stdout,
        stderr=stderr,
        exit_code=code,
        duration_ms=duration_ms,
        timed_out=timed_out,
        stdout_truncated=stdout_truncated,
        stderr_truncated=stderr_truncated,
        files_created=files_created,
        runtime_info={
            "lang": req.lang,
            "timeout_s": req.timeout_seconds,
            "session_id": req.session_id,
            "ephemeral": is_temp,
        },
    )


@app.delete("/v1/sessions/{session_id}", status_code=204, response_class=Response)
async def cleanup_session(
    session_id: str,
    _auth: None = Depends(require_auth),
) -> Response:
    """Supprime un workdir de session persistante. Pas auto-purgé sinon
    (les sessions vivent jusqu'au restart du container, tmpfs).

    FastAPI ≥0.115 exige Response explicite quand status=204.
    """
    if not SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="invalid_session_id")
    wd = WORK_BASE / session_id
    if wd.exists():
        shutil.rmtree(wd, ignore_errors=True)
        log.info("cleanup session %s", session_id)
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
