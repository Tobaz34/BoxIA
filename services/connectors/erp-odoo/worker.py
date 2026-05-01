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
from fastapi.responses import Response

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


# ===========================================================================
# Use case "factures impayées > N jours"
# ===========================================================================

@app.get("/invoices/unpaid")
def list_unpaid_invoices(
    days_overdue: int = Query(30, ge=0, le=3650),
    limit: int = 100,
    authorization: Annotated[str | None, Header()] = None,
) -> list[dict]:
    """USE CASE STAR : factures clients impayées au-delà de N jours.

    Filtre côté Odoo + sort en Python par retard décroissant.
    """
    from datetime import date, timedelta
    auth(authorization)
    cutoff = (date.today() - timedelta(days=days_overdue)).isoformat()
    domain = [
        ("move_type", "=", "out_invoice"),
        ("state", "=", "posted"),
        ("payment_state", "in", ("not_paid", "partial")),
        ("invoice_date_due", "<", cutoff),
    ]
    ids = _execute("account.move", "search", [domain], {"limit": limit, "order": "invoice_date_due asc"})
    if not ids:
        return []
    rows = _execute(
        "account.move", "read", [ids],
        {"fields": [
            "id", "name", "partner_id", "amount_total", "amount_residual",
            "state", "invoice_date", "invoice_date_due", "payment_state",
        ]},
    )
    today = date.today()
    for r in rows:
        try:
            due = date.fromisoformat(str(r.get("invoice_date_due") or ""))
            r["days_overdue"] = max(0, (today - due).days)
        except Exception:
            r["days_overdue"] = None
    rows.sort(key=lambda r: r.get("days_overdue") or 0, reverse=True)
    return rows


# ===========================================================================
# Endpoint PDF : récupération du PDF d'une facture
# ===========================================================================

@app.get("/invoices/{invoice_id}/pdf")
def get_invoice_pdf(
    invoice_id: int,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """Renvoie le PDF de la facture (binaire) via le report `account.report_invoice`.

    Implémentation : on appelle `report.report` API d'Odoo qui renvoie le binaire base64.
    """
    auth(authorization)
    import base64

    # Vérifie que la facture existe et est postée
    inv = _execute("account.move", "read", [[invoice_id]],
                   {"fields": ["id", "name", "state", "move_type"]})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv[0]["move_type"] not in ("out_invoice", "out_refund"):
        raise HTTPException(400, "Pas une facture client")

    # Méthode Odoo 16+ : `_render_qweb_pdf` sur le report account.report_invoice
    try:
        result = _execute(
            "ir.actions.report",
            "_render_qweb_pdf",
            ["account.report_invoice", [invoice_id]],
            {},
        )
        # result = (pdf_bytes_or_b64, "pdf")
        pdf_data, _fmt = result
        if isinstance(pdf_data, str):
            pdf_bytes = base64.b64decode(pdf_data)
        else:
            pdf_bytes = pdf_data
    except Exception as e:
        log.error("PDF generation failed for invoice %s: %s", invoice_id, e)
        raise HTTPException(500, f"PDF generation failed: {e}")

    filename = f"{inv[0].get('name', f'invoice_{invoice_id}').replace('/', '_')}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ===========================================================================
# Webhook simulé : scheduler interne pour alertes "facture impayée >30j"
# ===========================================================================
# Odoo n'a pas de webhooks natifs. On expose un endpoint POST /alerts/run que
# n8n/cron peut appeler périodiquement, et qui retourne la liste des alertes
# à émettre (impayés franchissant un seuil de retard depuis le dernier run).

_alert_state_file = "/data/odoo_last_alert_ids.txt"


def _load_alerted_ids() -> set[int]:
    try:
        with open(_alert_state_file) as f:
            return {int(line.strip()) for line in f if line.strip()}
    except FileNotFoundError:
        return set()


def _save_alerted_ids(ids: set[int]) -> None:
    import os
    os.makedirs("/data", exist_ok=True)
    with open(_alert_state_file, "w") as f:
        f.write("\n".join(str(i) for i in sorted(ids)))


@app.post("/alerts/run")
def run_alerts(
    days_overdue: int = 30,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Renvoie les NOUVELLES factures impayées > N jours (jamais alertées).

    Idempotent : conserve un état des IDs déjà alertés dans /data/.
    À appeler depuis n8n (cron quotidien) → router vers Slack/email/Mattermost.
    """
    auth(authorization)
    overdue = list_unpaid_invoices(days_overdue=days_overdue, limit=500, authorization=authorization)
    alerted = _load_alerted_ids()
    new_alerts = [inv for inv in overdue if inv["id"] not in alerted]
    _save_alerted_ids(alerted | {inv["id"] for inv in overdue})
    return {
        "new_alerts": len(new_alerts),
        "total_overdue": len(overdue),
        "alerts": new_alerts,
    }
