"""FastAPI app — expose les 3 agents autonomes en HTTP.

Endpoints :
- GET  /healthz                   → liveness
- GET  /v1/info                   → diagnostic backend (model, profil, etc.)
- POST /v1/triage-email           → agent triage email
- POST /v1/generate-quote         → agent génération devis
- POST /v1/reconcile-invoice      → agent rapprochement facture
- GET  /metrics                   → Prometheus

Auth : Bearer token (header `Authorization: Bearer <AGENTS_API_KEY>`).
Toutes les routes sauf /healthz et /metrics sont protégées.

CORS : par défaut OUVERT pour permettre à Dify (peut tourner sur n'importe quel
host) de consommer les endpoints. À durcir si exposition LAN/WAN.
"""
from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from app import __version__
from app.config import get_settings
from app.graphs import email_triage, invoice_reconciliation, quote_generator
from app.llm import get_backend_info
from app.persistence import get_mode as get_checkpointer_mode
from app.persistence import lifespan_checkpointer
from app.schemas import (
    GenerateQuoteRequest,
    GenerateQuoteResponse,
    ReconcileInvoiceRequest,
    ReconcileInvoiceResponse,
    TriageEmailRequest,
    TriageEmailResponse,
)


# =============================================================================
# Logging
# =============================================================================

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


# =============================================================================
# Métriques Prometheus
# =============================================================================

REQUEST_COUNT = Counter(
    "aibox_agents_requests_total",
    "Nombre de requêtes par agent et statut",
    ["agent", "status"],
)
REQUEST_LATENCY = Histogram(
    "aibox_agents_request_duration_seconds",
    "Latence par agent",
    ["agent"],
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120),
)


# =============================================================================
# Auth
# =============================================================================

bearer_scheme = HTTPBearer(auto_error=False)


def require_api_key(creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    s = get_settings()
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != s.agents_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key invalide ou manquante",
            headers={"WWW-Authenticate": "Bearer"},
        )


# =============================================================================
# App lifecycle
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    _setup_logging()
    s = get_settings()
    log = structlog.get_logger("aibox.agents")
    log.info(
        "agents_service_starting",
        version=__version__,
        backend=s.inference_backend,
        model=s.llm_main,
        hw_profile=s.hw_profile,
        outlines=s.enable_outlines,
    )

    # Init checkpointer (lifecycle async — boot + cleanup)
    async with lifespan_checkpointer():
        # Pré-construction des graphs (warmup, évite latence au 1er appel)
        # Les graphs sont reconstruits avec checkpointer si dispo via get_graph()
        email_triage.get_graph()
        quote_generator.get_graph()
        invoice_reconciliation.get_graph()

        log.info("checkpointer_mode", mode=get_checkpointer_mode())

        yield

    log.info("agents_service_stopping")


app = FastAPI(
    title="AI Box — Agents Autonomes",
    description="Service LangGraph sidecar : triage email, génération devis, rapprochement facture.",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# =============================================================================
# Middleware: timing + métriques
# =============================================================================

@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/v1/"):
        return await call_next(request)

    agent_name = path.removeprefix("/v1/").split("/")[0].replace("-", "_")
    start = time.time()
    try:
        response = await call_next(request)
        REQUEST_COUNT.labels(agent=agent_name, status=str(response.status_code)).inc()
        return response
    except Exception:
        REQUEST_COUNT.labels(agent=agent_name, status="500").inc()
        raise
    finally:
        REQUEST_LATENCY.labels(agent=agent_name).observe(time.time() - start)


# =============================================================================
# Routes publiques (no auth)
# =============================================================================

@app.get("/healthz", response_class=PlainTextResponse)
async def healthz():
    return "OK"


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/v1/info")
async def info():
    """Pas authentifié — utile pour Dify pour valider la config."""
    return {
        "service": "aibox-agents",
        "version": __version__,
        "checkpointer": get_checkpointer_mode(),
        **get_backend_info(),
    }


# =============================================================================
# Routes agents (auth requise)
# =============================================================================

@app.post(
    "/v1/triage-email",
    response_model=TriageEmailResponse,
    dependencies=[Depends(require_api_key)],
    summary="Trie un email entrant et propose une réponse + actions",
)
async def triage_email(
    request: TriageEmailRequest,
    x_thread_id: str | None = Header(None, description="ID de thread pour reprendre un workflow checkpointé"),
):
    log = structlog.get_logger("aibox.agents")
    try:
        result = await email_triage.run(request, thread_id=x_thread_id)
        log.info(
            "email_triage_done",
            category=result.category,
            priority=result.priority,
            confidence=result.confidence,
            duration_ms=result.metadata.duration_ms if result.metadata else None,
        )
        return result
    except Exception as e:
        log.error("email_triage_failed", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Triage failed: {type(e).__name__}: {e}")


@app.post(
    "/v1/generate-quote",
    response_model=GenerateQuoteResponse,
    dependencies=[Depends(require_api_key)],
    summary="Génère un devis structuré depuis un brief client en langage naturel",
)
async def generate_quote(
    request: GenerateQuoteRequest,
    x_thread_id: str | None = Header(None),
):
    log = structlog.get_logger("aibox.agents")
    try:
        result = await quote_generator.run(request, thread_id=x_thread_id)
        log.info(
            "quote_generated",
            quote_number=result.quote_number,
            total_eur=str(result.total_eur),
            line_count=len(result.line_items),
            duration_ms=result.metadata.duration_ms if result.metadata else None,
        )
        return result
    except Exception as e:
        log.error("quote_generation_failed", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Quote generation failed: {type(e).__name__}: {e}")


@app.post(
    "/v1/reconcile-invoice",
    response_model=ReconcileInvoiceResponse,
    dependencies=[Depends(require_api_key)],
    summary="Rapproche une facture avec ses candidats (commandes ou paiements)",
)
async def reconcile_invoice(
    request: ReconcileInvoiceRequest,
    x_thread_id: str | None = Header(None),
):
    log = structlog.get_logger("aibox.agents")
    try:
        result = await invoice_reconciliation.run(request, thread_id=x_thread_id)
        log.info(
            "invoice_reconciled",
            invoice_number=result.invoice_data.invoice_number,
            match_status=result.match_status,
            confidence=result.confidence,
            duration_ms=result.metadata.duration_ms if result.metadata else None,
        )
        return result
    except Exception as e:
        log.error("invoice_reconciliation_failed", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Reconciliation failed: {type(e).__name__}: {e}")


# =============================================================================
# Handler global d'erreur (json propre)
# =============================================================================

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log = structlog.get_logger("aibox.agents")
    log.error("unhandled_exception", path=request.url.path, error=str(exc), exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}"},
    )
