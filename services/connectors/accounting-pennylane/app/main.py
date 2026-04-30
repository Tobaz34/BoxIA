"""Connecteur Pennylane — wrapper REST consommable par Dify / n8n.

Endpoints exposés (FastAPI, port 8000) :
  GET  /healthz
  GET  /v1/info
  GET  /customers?q=<search>&limit=20
  GET  /customers/{id}
  GET  /invoices?status=&days_overdue=&limit=20  (factures clients)
  GET  /invoices/unpaid?days_overdue=30          (impayés > N jours, use case star)
  GET  /invoices/{id}
  GET  /quotes?status=&limit=20
  GET  /supplier_invoices?status=&limit=20

Sécurité :
  - Bearer token (PENNYLANE_TOOL_API_KEY) requis sur tous endpoints sauf /healthz
  - Lecture seule (aucun POST/PATCH/DELETE exposé pour l'instant : sécurité comptable)
  - Bind 127.0.0.1 par défaut (compose)

Pourquoi pas de SDK officiel : Pennylane ne publie pas de SDK Python.
L'API REST est triviale, ~200 lignes suffisent.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Annotated, Any

import httpx
import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app import __version__


# ===========================================================================
# Settings
# ===========================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    pennylane_token: str = Field(..., alias="PENNYLANE_TOKEN")
    pennylane_base_url: str = Field(
        "https://app.pennylane.com/api/external/v1",
        alias="PENNYLANE_BASE_URL",
    )
    pennylane_tool_api_key: str = Field(..., alias="PENNYLANE_TOOL_API_KEY")
    tenant_id: str = Field("default", alias="TENANT_ID")
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    http_timeout_seconds: int = Field(20, alias="HTTP_TIMEOUT_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


# ===========================================================================
# Logging
# ===========================================================================

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
# Pennylane client
# ===========================================================================

class PennylaneError(Exception):
    pass


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, PennylaneError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=8),
    reraise=True,
)
def _pennylane_get(path: str, params: dict | None = None) -> dict:
    """Appel REST Pennylane avec retry + auth bearer."""
    s = get_settings()
    url = f"{s.pennylane_base_url}{path}"
    headers = {"Authorization": f"Bearer {s.pennylane_token}", "Accept": "application/json"}
    with httpx.Client(timeout=s.http_timeout_seconds) as c:
        r = c.get(url, headers=headers, params=params or {})
        if r.status_code >= 400:
            raise PennylaneError(f"Pennylane {r.status_code}: {r.text[:300]}")
        return r.json()


def _paginate(path: str, params: dict | None = None, key: str = "items", max_pages: int = 50) -> list[dict]:
    """Itère sur la pagination Pennylane (page/per_page)."""
    out: list[dict] = []
    page = 1
    base_params = dict(params or {})
    base_params.setdefault("per_page", 50)

    while page <= max_pages:
        base_params["page"] = page
        data = _pennylane_get(path, base_params)
        # Pennylane renvoie {"items": [...], "pagination": {"current_page": X, "total_pages": Y}}
        # OU parfois {"customer_invoices": [...], "pagination": ...} selon l'endpoint historique.
        items = data.get(key) or data.get("items") or []
        if not items:
            # Auto-detect si l'endpoint utilise une autre clé (ex. "customer_invoices", "quotes")
            for k, v in data.items():
                if isinstance(v, list) and v:
                    items = v
                    break
        out.extend(items)
        pagination = data.get("pagination", {})
        total_pages = pagination.get("total_pages", page)
        if page >= total_pages:
            break
        page += 1
    return out


# ===========================================================================
# Schemas (sortie normalisée — pas le payload Pennylane brut)
# ===========================================================================

class Customer(BaseModel):
    id: int | str
    name: str
    email: str | None = None
    siren: str | None = None
    siret: str | None = None
    address: str | None = None
    raw: dict = Field(default_factory=dict, description="Payload Pennylane brut")


class Invoice(BaseModel):
    id: int | str
    invoice_number: str | None = None
    customer_name: str | None = None
    issue_date: date | None = None
    deadline: date | None = None
    amount_eur: float | None = None
    currency: str = "EUR"
    status: str | None = None
    days_overdue: int | None = None
    raw: dict = Field(default_factory=dict)


class Quote(BaseModel):
    id: int | str
    quote_number: str | None = None
    customer_name: str | None = None
    issue_date: date | None = None
    amount_eur: float | None = None
    status: str | None = None
    raw: dict = Field(default_factory=dict)


# Mapping flexible Pennylane → notre schéma normalisé
def _normalize_customer(p: dict) -> Customer:
    return Customer(
        id=p.get("id") or p.get("source_id", ""),
        name=p.get("name") or p.get("company_name") or p.get("first_name", "") + " " + p.get("last_name", ""),
        email=(p.get("emails") or [None])[0] if isinstance(p.get("emails"), list) else p.get("billing_email"),
        siren=p.get("siren"),
        siret=p.get("siret"),
        address=_format_address(p),
        raw=p,
    )


def _format_address(p: dict) -> str | None:
    parts = [p.get("billing_address"), p.get("billing_postal_code"), p.get("billing_city")]
    s = " ".join(str(x) for x in parts if x)
    return s.strip() or None


def _parse_iso_date(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _normalize_invoice(p: dict) -> Invoice:
    deadline = _parse_iso_date(p.get("deadline") or p.get("due_date"))
    days_overdue = None
    if deadline:
        delta = (date.today() - deadline).days
        days_overdue = max(0, delta)

    cust = p.get("customer") or {}
    return Invoice(
        id=p.get("id") or p.get("invoice_number", ""),
        invoice_number=p.get("invoice_number") or p.get("number"),
        customer_name=(cust.get("name") if isinstance(cust, dict) else None) or p.get("customer_name"),
        issue_date=_parse_iso_date(p.get("date") or p.get("issue_date") or p.get("created_at")),
        deadline=deadline,
        amount_eur=_to_float(p.get("amount") or p.get("total") or p.get("total_amount")),
        currency=p.get("currency", "EUR"),
        status=p.get("status") or p.get("payment_status"),
        days_overdue=days_overdue,
        raw=p,
    )


def _normalize_quote(p: dict) -> Quote:
    cust = p.get("customer") or {}
    return Quote(
        id=p.get("id") or "",
        quote_number=p.get("quote_number") or p.get("number"),
        customer_name=(cust.get("name") if isinstance(cust, dict) else None) or p.get("customer_name"),
        issue_date=_parse_iso_date(p.get("date") or p.get("issue_date")),
        amount_eur=_to_float(p.get("amount") or p.get("total") or p.get("total_amount")),
        status=p.get("status"),
        raw=p,
    )


def _to_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ===========================================================================
# Auth
# ===========================================================================

bearer = HTTPBearer(auto_error=False)


def require_api_key(creds: HTTPAuthorizationCredentials | None = Depends(bearer)):
    s = get_settings()
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != s.pennylane_tool_api_key:
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
    title="AI Box — Pennylane Tool",
    version=__version__,
    description="Wrapper REST Pennylane consommable par Dify / n8n. Lecture seule.",
)


from fastapi.requests import Request
from fastapi.responses import JSONResponse


@app.exception_handler(PennylaneError)
async def pennylane_error_handler(request: Request, exc: PennylaneError):
    return JSONResponse(status_code=502, content={"detail": f"Pennylane upstream error: {exc}"})


@app.exception_handler(httpx.HTTPError)
async def httpx_error_handler(request: Request, exc: httpx.HTTPError):
    return JSONResponse(status_code=502, content={"detail": f"Pennylane HTTP error: {exc}"})


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "OK"


@app.get("/v1/info")
def info() -> dict:
    s = get_settings()
    return {
        "service": "aibox-conn-pennylane",
        "version": __version__,
        "tenant": s.tenant_id,
        "base_url": s.pennylane_base_url,
    }


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------

@app.get("/customers", dependencies=[Depends(require_api_key)])
def list_customers(
    q: str | None = Query(None, description="Recherche par nom/email"),
    limit: int = Query(20, ge=1, le=200),
) -> list[Customer]:
    params: dict[str, Any] = {"per_page": limit}
    if q:
        params["filter[name]"] = q
    items = _pennylane_get("/customers", params).get("items") or []
    return [_normalize_customer(p) for p in items[:limit]]


@app.get("/customers/{customer_id}", dependencies=[Depends(require_api_key)])
def get_customer(customer_id: str) -> Customer:
    data = _pennylane_get(f"/customers/{customer_id}")
    # API peut wrapper dans {"customer": {...}}
    payload = data.get("customer") or data
    return _normalize_customer(payload)


# ---------------------------------------------------------------------------
# Invoices clients
# ---------------------------------------------------------------------------

@app.get("/invoices", dependencies=[Depends(require_api_key)])
def list_invoices(
    status: str | None = Query(None, description="upcoming | paid | late | …"),
    days_overdue: int | None = Query(None, ge=0, description="Filtrer factures impayées > N jours"),
    limit: int = Query(20, ge=1, le=200),
) -> list[Invoice]:
    params: dict[str, Any] = {"per_page": limit}
    if status:
        params["filter[status]"] = status
    if days_overdue is not None:
        cutoff = (date.today() - timedelta(days=days_overdue)).isoformat()
        params["filter[deadline_before]"] = cutoff

    items = _pennylane_get("/customer_invoices", params).get("items") or []
    return [_normalize_invoice(p) for p in items[:limit]]


@app.get("/invoices/unpaid", dependencies=[Depends(require_api_key)])
def list_unpaid_invoices(
    days_overdue: int = Query(30, ge=0, le=3650, description="Seuil de retard en jours"),
    limit: int = Query(50, ge=1, le=500),
) -> list[Invoice]:
    """USE CASE STAR : factures clients impayées au-delà de N jours."""
    cutoff = (date.today() - timedelta(days=days_overdue)).isoformat()
    items = _paginate(
        "/customer_invoices",
        params={
            "per_page": min(limit, 50),
            "filter[status]": "upcoming",
            "filter[deadline_before]": cutoff,
        },
    )
    invoices = [_normalize_invoice(p) for p in items]
    # Tri par retard décroissant
    invoices.sort(key=lambda x: x.days_overdue or 0, reverse=True)
    return invoices[:limit]


@app.get("/invoices/{invoice_id}", dependencies=[Depends(require_api_key)])
def get_invoice(invoice_id: str) -> Invoice:
    data = _pennylane_get(f"/customer_invoices/{invoice_id}")
    payload = data.get("customer_invoice") or data.get("invoice") or data
    return _normalize_invoice(payload)


# ---------------------------------------------------------------------------
# Quotes
# ---------------------------------------------------------------------------

@app.get("/quotes", dependencies=[Depends(require_api_key)])
def list_quotes(
    status: str | None = Query(None),
    limit: int = Query(20, ge=1, le=200),
) -> list[Quote]:
    params: dict[str, Any] = {"per_page": limit}
    if status:
        params["filter[status]"] = status
    items = _pennylane_get("/quotes", params).get("items") or []
    return [_normalize_quote(p) for p in items[:limit]]


# ---------------------------------------------------------------------------
# Supplier invoices (factures fournisseurs)
# ---------------------------------------------------------------------------

@app.get("/supplier_invoices", dependencies=[Depends(require_api_key)])
def list_supplier_invoices(
    status: str | None = Query(None),
    limit: int = Query(20, ge=1, le=200),
) -> list[Invoice]:
    params: dict[str, Any] = {"per_page": limit}
    if status:
        params["filter[status]"] = status
    items = _pennylane_get("/supplier_invoices", params).get("items") or []
    return [_normalize_invoice(p) for p in items[:limit]]
