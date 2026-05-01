"""Import FEC — endpoint REST universel pour la compta française.

POST /v1/import          (multipart upload .txt/.csv)
GET  /v1/imports         (liste des imports stockés)
GET  /v1/imports/{id}/summary   (rapport + agrégats)
GET  /v1/imports/{id}/entries   (top N lignes paginées)
GET  /v1/imports/{id}/anomalies (détection heuristique)
GET  /v1/imports/{id}/journals  (Σ par journal)
GET  /v1/imports/{id}/classes   (Σ par classe PCG)
DELETE /v1/imports/{id}  (RGPD : suppression complète)

Stockage : un FEC = 1 fichier JSON dans FEC_DATA_DIR/<id>.json
+ source originale conservée pour ré-analyse si besoin.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import Depends, FastAPI, File, HTTPException, Path as FPath, Query, UploadFile, status
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app import __version__
from app.parser import (
    FECParseError,
    aggregate_by_compte_class,
    aggregate_by_journal,
    detect_anomalies,
    parse_fec_bytes,
)


# ===========================================================================
# Settings
# ===========================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    fec_tool_api_key: str = Field(..., alias="FEC_TOOL_API_KEY")
    fec_max_file_mb: int = Field(100, alias="FEC_MAX_FILE_MB")
    fec_data_dir: str = Field("/data", alias="FEC_DATA_DIR")
    tenant_id: str = Field("default", alias="TENANT_ID")
    log_level: str = Field("INFO", alias="LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def data_dir() -> Path:
    p = Path(get_settings().fec_data_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _setup_logging():
    s = get_settings()
    level = getattr(logging, s.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, stream=sys.stdout, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
    )


# ===========================================================================
# JSON helpers
# ===========================================================================

def _to_jsonable(obj: Any) -> Any:
    """Decimal/date/datetime → string pour stockage JSON."""
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_jsonable(x) for x in obj]
    if hasattr(obj, "__dict__"):
        return {k: _to_jsonable(v) for k, v in obj.__dict__.items()}
    return obj


# ===========================================================================
# Auth
# ===========================================================================

bearer = HTTPBearer(auto_error=False)


def require_api_key(creds: HTTPAuthorizationCredentials | None = Depends(bearer)):
    s = get_settings()
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != s.fec_tool_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key invalide ou manquante",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ===========================================================================
# App
# ===========================================================================

_setup_logging()
app = FastAPI(
    title="AI Box — Import FEC",
    version=__version__,
    description="Endpoint universel d'import du FEC légal français. Couvre Sage/EBP/Cegid/etc. sans partenariat.",
)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "OK"


@app.get("/v1/info")
def info() -> dict:
    s = get_settings()
    return {
        "service": "aibox-conn-fec",
        "version": __version__,
        "tenant": s.tenant_id,
        "max_file_mb": s.fec_max_file_mb,
        "data_dir": s.fec_data_dir,
    }


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

class ImportResult(BaseModel):
    import_id: str
    filename: str
    parsed_entries: int
    skipped_lines: int
    period_min: str | None
    period_max: str | None
    total_debit: str
    total_credit: str
    is_balanced: bool
    columns_match_legal: bool
    anomaly_count: int
    error_count: int


@app.post("/v1/import", response_model=ImportResult, dependencies=[Depends(require_api_key)])
async def import_fec(
    file: UploadFile = File(..., description="FEC légal .txt ou .csv"),
    strict: bool = Query(False, description="Lève à la 1ère anomalie si True"),
) -> ImportResult:
    s = get_settings()
    log = structlog.get_logger("aibox.fec")

    blob = await file.read()
    max_bytes = s.fec_max_file_mb * 1024 * 1024
    if len(blob) > max_bytes:
        raise HTTPException(
            413, f"Fichier > {s.fec_max_file_mb} Mo (limite configurée)"
        )

    try:
        entries, report = parse_fec_bytes(blob, max_size_bytes=max_bytes, strict=strict)
    except FECParseError as e:
        log.warning("fec_parse_error", error=str(e), filename=file.filename)
        raise HTTPException(400, f"FEC parse error: {e}")

    anomalies = detect_anomalies(entries, report)

    import_id = uuid.uuid4().hex
    storage_path = data_dir() / f"{import_id}.json"
    payload = {
        "import_id": import_id,
        "filename": file.filename,
        "imported_at": datetime.utcnow().isoformat(),
        "report": _to_jsonable(report),
        "anomalies": anomalies,
        "entries": [_to_jsonable(e) for e in entries],
    }
    storage_path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )

    log.info(
        "fec_imported",
        import_id=import_id,
        filename=file.filename,
        entries=report.parsed_entries,
        balanced=report.is_balanced,
        anomalies=len(anomalies),
    )

    return ImportResult(
        import_id=import_id,
        filename=file.filename or "(unknown)",
        parsed_entries=report.parsed_entries,
        skipped_lines=report.skipped_lines,
        period_min=report.period_min.isoformat() if report.period_min else None,
        period_max=report.period_max.isoformat() if report.period_max else None,
        total_debit=str(report.total_debit),
        total_credit=str(report.total_credit),
        is_balanced=report.is_balanced,
        columns_match_legal=report.columns_match_legal,
        anomaly_count=len(anomalies),
        error_count=len(report.errors),
    )


# ---------------------------------------------------------------------------
# Listing & retrieval
# ---------------------------------------------------------------------------

def _load_import(import_id: str) -> dict:
    if not import_id.replace("-", "").isalnum():
        raise HTTPException(400, "import_id invalide")
    p = data_dir() / f"{import_id}.json"
    if not p.exists():
        raise HTTPException(404, "Import non trouvé")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/v1/imports", dependencies=[Depends(require_api_key)])
def list_imports() -> list[dict]:
    out = []
    for p in sorted(data_dir().glob("*.json"), reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append({
                "import_id": d.get("import_id"),
                "filename": d.get("filename"),
                "imported_at": d.get("imported_at"),
                "parsed_entries": d.get("report", {}).get("parsed_entries"),
                "is_balanced": d.get("report", {}).get("is_balanced"),
            })
        except Exception:
            continue
    return out


@app.get("/v1/imports/{import_id}/summary", dependencies=[Depends(require_api_key)])
def import_summary(import_id: str) -> dict:
    d = _load_import(import_id)
    rep = d["report"]
    return {
        "import_id": import_id,
        "filename": d["filename"],
        "imported_at": d["imported_at"],
        "report": rep,
        "anomaly_count": len(d.get("anomalies", [])),
    }


@app.get("/v1/imports/{import_id}/entries", dependencies=[Depends(require_api_key)])
def import_entries(
    import_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=1000),
    journal: str | None = None,
    compte_prefix: str | None = None,
) -> dict:
    d = _load_import(import_id)
    entries = d.get("entries", [])
    if journal:
        entries = [e for e in entries if e["journal_code"] == journal]
    if compte_prefix:
        entries = [e for e in entries if e["compte_num"].startswith(compte_prefix)]
    return {
        "total": len(entries),
        "items": entries[skip: skip + limit],
    }


@app.get("/v1/imports/{import_id}/anomalies", dependencies=[Depends(require_api_key)])
def import_anomalies(import_id: str) -> list[dict]:
    return _load_import(import_id).get("anomalies", [])


@app.get("/v1/imports/{import_id}/journals", dependencies=[Depends(require_api_key)])
def import_journals(import_id: str) -> dict:
    d = _load_import(import_id)
    # Re-aggrégation depuis les entries (pour rester source of truth)
    from app.parser import FECEntry  # for typing reference
    raw_entries = d.get("entries", [])
    # Reconstitue partial — on utilise directement les fields
    out = {}
    for e in raw_entries:
        jc = e["journal_code"]
        if jc not in out:
            out[jc] = {"journal_lib": e["journal_lib"], "debit": "0", "credit": "0", "count": 0}
        out[jc]["debit"] = str(Decimal(out[jc]["debit"]) + Decimal(e["debit"]))
        out[jc]["credit"] = str(Decimal(out[jc]["credit"]) + Decimal(e["credit"]))
        out[jc]["count"] += 1
    return out


@app.get("/v1/imports/{import_id}/classes", dependencies=[Depends(require_api_key)])
def import_classes(import_id: str) -> dict:
    """Σ par classe comptable PCG (1=capitaux, 2=immo, 3=stocks, 4=tiers, 5=trésorerie, 6=charges, 7=produits)."""
    PCG_LABELS = {
        "1": "Capitaux", "2": "Immobilisations", "3": "Stocks",
        "4": "Tiers", "5": "Trésorerie", "6": "Charges", "7": "Produits",
        "8": "Spéciaux", "9": "Analytique",
    }
    d = _load_import(import_id)
    out: dict[str, dict] = {}
    for e in d.get("entries", []):
        cls = e["compte_num"][:1] if e["compte_num"] else "?"
        if cls not in out:
            out[cls] = {"label": PCG_LABELS.get(cls, "Inconnu"), "debit": "0", "credit": "0", "count": 0}
        out[cls]["debit"] = str(Decimal(out[cls]["debit"]) + Decimal(e["debit"]))
        out[cls]["credit"] = str(Decimal(out[cls]["credit"]) + Decimal(e["credit"]))
        out[cls]["count"] += 1
    return out


@app.delete("/v1/imports/{import_id}", dependencies=[Depends(require_api_key)])
def delete_import(import_id: str) -> dict:
    if not import_id.replace("-", "").isalnum():
        raise HTTPException(400, "import_id invalide")
    p = data_dir() / f"{import_id}.json"
    if not p.exists():
        raise HTTPException(404, "Import non trouvé")
    p.unlink()
    return {"deleted": import_id}


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(FECParseError)
async def fec_error_handler(request, exc: FECParseError):
    return JSONResponse(status_code=400, content={"detail": f"FEC parse error: {exc}"})
