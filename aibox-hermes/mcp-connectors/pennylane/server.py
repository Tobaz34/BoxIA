"""AI Box — serveur MCP Pennylane (shim sur le microservice FastAPI existant).

Expose les endpoints LECTURE SEULE du connecteur Pennylane
(`services/connectors/accounting-pennylane`) en tools MCP consommables par
Hermes Agent. Aucune écriture (sécurité comptable). Hermes les voit comme
`mcp_pennylane_<tool>`.

Pourquoi un shim plutôt qu'un appel direct à l'API Pennylane : le FastAPI
existant porte déjà la normalisation, le retry, la pagination et l'auth.
On le réutilise tel quel (cf. PORT-MAP : ♻️ réutilisé).

Env :
  PENNYLANE_TOOL_BASE_URL  URL du microservice FastAPI (def: http://127.0.0.1:8081)
  PENNYLANE_TOOL_API_KEY   Bearer pour authentifier ce shim auprès du FastAPI
  PENNYLANE_TOOL_TIMEOUT   timeout HTTP en secondes (def: 30)

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
  fastmcp list server.py:mcp --json
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from fastmcp import FastMCP

mcp = FastMCP("pennylane")

BASE_URL = os.getenv("PENNYLANE_TOOL_BASE_URL", "http://127.0.0.1:8081")
API_KEY = os.getenv("PENNYLANE_TOOL_API_KEY", "")
TIMEOUT = float(os.getenv("PENNYLANE_TOOL_TIMEOUT", "30"))


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json"}
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    return h


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    """Appel GET sur le microservice FastAPI Pennylane. Lève sur erreur HTTP."""
    url = f"{BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    with httpx.Client(timeout=TIMEOUT, headers=_headers()) as c:
        r = c.get(url, params=params or {})
        r.raise_for_status()
        return r.json()


@mcp.tool
def pennylane_health() -> dict[str, Any]:
    """Vérifie que le connecteur comptable Pennylane est joignable et configuré."""
    return {"ok": True, "info": _get("/v1/info")}


@mcp.tool
def list_unpaid_invoices(days_overdue: int = 30, limit: int = 50) -> list[dict[str, Any]]:
    """Liste les factures CLIENTS impayées au-delà de N jours de retard (cas d'usage phare).

    days_overdue : seuil de retard en jours (défaut 30).
    limit : nombre max de résultats. Trié par retard décroissant. Lecture seule.
    """
    return _get("/invoices/unpaid", {"days_overdue": days_overdue, "limit": limit})


@mcp.tool
def list_invoices(
    status: str | None = None, days_overdue: int | None = None, limit: int = 20
) -> list[dict[str, Any]]:
    """Liste les factures clients. status: upcoming|paid|late. days_overdue: filtre retard. Lecture seule."""
    params: dict[str, Any] = {"limit": limit}
    if status:
        params["status"] = status
    if days_overdue is not None:
        params["days_overdue"] = days_overdue
    return _get("/invoices", params)


@mcp.tool
def get_invoice(invoice_id: str) -> dict[str, Any]:
    """Détail d'une facture client par son identifiant. Lecture seule."""
    return _get(f"/invoices/{invoice_id}")


@mcp.tool
def list_customers(q: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Recherche / liste les clients. q : filtre par nom ou email. Lecture seule."""
    params: dict[str, Any] = {"limit": limit}
    if q:
        params["q"] = q
    return _get("/customers", params)


@mcp.tool
def get_customer(customer_id: str) -> dict[str, Any]:
    """Détail d'un client par son identifiant. Lecture seule."""
    return _get(f"/customers/{customer_id}")


@mcp.tool
def list_quotes(status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Liste les devis. status optionnel. Lecture seule."""
    params: dict[str, Any] = {"limit": limit}
    if status:
        params["status"] = status
    return _get("/quotes", params)


@mcp.tool
def list_supplier_invoices(status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Liste les factures FOURNISSEURS. status optionnel. Lecture seule."""
    params: dict[str, Any] = {"limit": limit}
    if status:
        params["status"] = status
    return _get("/supplier_invoices", params)


if __name__ == "__main__":
    mcp.run()
