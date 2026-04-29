"""
Connecteur Odoo — expose une API HTTP simple consommable par Dify (en tant
que "tool") + n8n. Pas de RAG ici (les données ERP sont structurées, on les
interroge directement à la demande).

Endpoints exposés (FastAPI, port 8000) :
  GET  /healthz
  GET  /partners?q=<search>            recherche un partenaire
  GET  /partners/{id}                   détail
  GET  /sale_orders?partner_id=&state=  liste devis/commandes
  GET  /sale_orders/{id}
  POST /sale_orders                    crée un devis (dans state=draft)
  GET  /invoices?partner_id=&state=     liste factures
  GET  /invoices/{id}/pdf               retourne le PDF de la facture

Variables :
  ODOO_URL          https://acme.odoo.com  (ou self-host)
  ODOO_DB           nom de base
  ODOO_USERNAME     user technique
  ODOO_API_KEY      clé API (Settings > Users > API keys)
  TENANT_ID
  ODOO_TOOL_API_KEY clé pour authentifier les appels Dify→ce service (Bearer)
"""
from __future__ import annotations

import logging
import os
import xmlrpc.client
from typing import Annotated, Any

from fastapi import FastAPI, Header, HTTPException, Query

ODOO_URL = os.environ["ODOO_URL"].rstrip("/")
ODOO_DB = os.environ["ODOO_DB"]
ODOO_USERNAME = os.environ["ODOO_USERNAME"]
ODOO_API_KEY = os.environ["ODOO_API_KEY"]
TENANT_ID = os.environ.get("TENANT_ID", "default")
TOOL_API_KEY = os.environ["ODOO_TOOL_API_KEY"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("erp-odoo")


def _connect():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common", allow_none=True)
    uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {})
    if not uid:
        raise RuntimeError("Odoo authentication failed")
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object", allow_none=True)
    return uid, models


def _execute(model: str, method: str, args: list, kwargs: dict | None = None) -> Any:
    uid, models = _connect()
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs or {})


# ---- App FastAPI ----
app = FastAPI(title="AI Box — Odoo Tool", version="0.1.0")


def auth(authorization: Annotated[str | None, Header()] = None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization.removeprefix("Bearer ").strip() != TOOL_API_KEY:
        raise HTTPException(401, "Invalid token")


@app.get("/healthz")
def healthz() -> dict:
    try:
        _connect()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/partners")
def search_partners(q: str = Query(...), _: None = None) -> list[dict]:
    auth(_)
    domain = ["|", ("name", "ilike", q), ("email", "ilike", q)]
    ids = _execute("res.partner", "search", [domain], {"limit": 10})
    if not ids:
        return []
    return _execute(
        "res.partner", "read", [ids],
        {"fields": ["id", "name", "email", "phone", "vat", "country_id", "is_company"]},
    )


@app.get("/partners/{partner_id}")
def get_partner(partner_id: int, authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    res = _execute("res.partner", "read", [[partner_id]], {})
    if not res:
        raise HTTPException(404, "Partner not found")
    return res[0]


@app.get("/sale_orders")
def list_sale_orders(
    partner_id: int | None = None,
    state: str | None = None,
    limit: int = 20,
    authorization: Annotated[str | None, Header()] = None,
) -> list[dict]:
    auth(authorization)
    domain = []
    if partner_id:
        domain.append(("partner_id", "=", partner_id))
    if state:
        domain.append(("state", "=", state))
    ids = _execute("sale.order", "search", [domain], {"limit": limit, "order": "date_order desc"})
    if not ids:
        return []
    return _execute(
        "sale.order", "read", [ids],
        {"fields": ["id", "name", "partner_id", "amount_total", "state", "date_order", "client_order_ref"]},
    )


@app.get("/sale_orders/{so_id}")
def get_sale_order(so_id: int, authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    so = _execute("sale.order", "read", [[so_id]], {})
    if not so:
        raise HTTPException(404, "Sale order not found")
    so = so[0]
    line_ids = so.get("order_line", [])
    lines = _execute(
        "sale.order.line", "read", [line_ids],
        {"fields": ["product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"]},
    ) if line_ids else []
    so["lines"] = lines
    return so


@app.post("/sale_orders")
def create_sale_order(
    payload: dict,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """payload = {partner_id, lines: [{product_id, qty, price_unit?}]}"""
    auth(authorization)
    partner_id = payload["partner_id"]
    lines = payload.get("lines", [])
    so_id = _execute("sale.order", "create", [{
        "partner_id": partner_id,
        "order_line": [
            (0, 0, {
                "product_id": ln["product_id"],
                "product_uom_qty": ln.get("qty", 1),
                **({"price_unit": ln["price_unit"]} if "price_unit" in ln else {}),
            })
            for ln in lines
        ],
    }])
    so = _execute("sale.order", "read", [[so_id]], {})
    return so[0] if so else {"id": so_id}


@app.get("/invoices")
def list_invoices(
    partner_id: int | None = None,
    state: str | None = None,
    limit: int = 20,
    authorization: Annotated[str | None, Header()] = None,
) -> list[dict]:
    auth(authorization)
    domain = [("move_type", "=", "out_invoice")]
    if partner_id:
        domain.append(("partner_id", "=", partner_id))
    if state:
        domain.append(("state", "=", state))
    ids = _execute("account.move", "search", [domain], {"limit": limit, "order": "invoice_date desc"})
    if not ids:
        return []
    return _execute(
        "account.move", "read", [ids],
        {"fields": ["id", "name", "partner_id", "amount_total", "state", "invoice_date", "invoice_date_due", "payment_state"]},
    )
