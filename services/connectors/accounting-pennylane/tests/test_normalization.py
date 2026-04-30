"""Tests unitaires (pas de réseau, mock httpx via respx)."""
from __future__ import annotations

import os

# Set env BEFORE importing the app
os.environ.setdefault("PENNYLANE_TOKEN", "test-pnl-token")
os.environ.setdefault("PENNYLANE_TOOL_API_KEY", "test-tool-key")
os.environ.setdefault("PENNYLANE_BASE_URL", "https://test-pennylane.local/api/external/v1")

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from app.main import _normalize_customer, _normalize_invoice, _normalize_quote, app


# ===== Pure function tests (no HTTP) ===========================================

def test_normalize_customer_with_company():
    raw = {
        "id": 42,
        "name": "Acme Textile SARL",
        "emails": ["contact@acme.fr"],
        "siren": "123456789",
        "siret": "12345678901234",
        "billing_address": "10 rue Bio",
        "billing_postal_code": "69000",
        "billing_city": "Lyon",
    }
    c = _normalize_customer(raw)
    assert c.id == 42
    assert c.name == "Acme Textile SARL"
    assert c.email == "contact@acme.fr"
    assert c.siren == "123456789"
    assert "Lyon" in (c.address or "")


def test_normalize_customer_with_first_last_name():
    raw = {"id": 1, "first_name": "Marie", "last_name": "Dupont", "billing_email": "marie@example.fr"}
    c = _normalize_customer(raw)
    assert "Marie" in c.name and "Dupont" in c.name
    assert c.email == "marie@example.fr"


def test_normalize_invoice_overdue():
    from datetime import date, timedelta
    past = (date.today() - timedelta(days=45)).isoformat()
    raw = {
        "id": 100,
        "invoice_number": "FA-2026-001",
        "deadline": past,
        "amount": "1234.56",
        "currency": "EUR",
        "status": "upcoming",
        "customer": {"name": "Acme"},
    }
    inv = _normalize_invoice(raw)
    assert inv.amount_eur == 1234.56
    assert inv.days_overdue == 45
    assert inv.customer_name == "Acme"


def test_normalize_invoice_not_overdue():
    from datetime import date, timedelta
    future = (date.today() + timedelta(days=10)).isoformat()
    raw = {"id": 1, "deadline": future, "amount": 100, "status": "upcoming"}
    inv = _normalize_invoice(raw)
    assert inv.days_overdue == 0


def test_normalize_invoice_handles_missing_fields():
    raw = {"id": "x", "total_amount": None, "status": "draft"}
    inv = _normalize_invoice(raw)
    assert inv.amount_eur is None
    assert inv.days_overdue is None
    assert inv.deadline is None


def test_normalize_quote():
    raw = {"id": 1, "quote_number": "DEV-2026-001", "amount": 5000, "status": "sent",
           "customer": {"name": "ClientX"}, "issue_date": "2026-04-01"}
    q = _normalize_quote(raw)
    assert q.amount_eur == 5000.0
    assert q.customer_name == "ClientX"


# ===== Endpoint tests with mocked Pennylane =====================================

@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_header():
    return {"Authorization": "Bearer test-tool-key"}


def test_healthz_no_auth(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.text == "OK"


def test_invoices_requires_auth(client):
    r = client.get("/invoices")
    assert r.status_code == 401


def test_invoices_wrong_key(client):
    r = client.get("/invoices", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


@respx.mock
def test_list_invoices(client, auth_header):
    respx.get("https://test-pennylane.local/api/external/v1/customer_invoices").mock(
        return_value=Response(200, json={
            "items": [
                {"id": 1, "invoice_number": "FA-001", "amount": "100.00", "deadline": "2026-12-31",
                 "status": "upcoming", "customer": {"name": "ClientA"}},
                {"id": 2, "invoice_number": "FA-002", "amount": "200.00", "deadline": "2026-12-31",
                 "status": "paid", "customer": {"name": "ClientB"}},
            ],
            "pagination": {"current_page": 1, "total_pages": 1},
        })
    )
    r = client.get("/invoices", headers=auth_header)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 2
    assert data[0]["invoice_number"] == "FA-001"


@respx.mock
def test_list_unpaid_invoices_sorted_by_overdue(client, auth_header):
    from datetime import date, timedelta
    d_oldest = (date.today() - timedelta(days=90)).isoformat()
    d_recent = (date.today() - timedelta(days=15)).isoformat()
    respx.get("https://test-pennylane.local/api/external/v1/customer_invoices").mock(
        return_value=Response(200, json={
            "items": [
                {"id": 1, "deadline": d_recent, "amount": 100, "status": "upcoming"},
                {"id": 2, "deadline": d_oldest, "amount": 200, "status": "upcoming"},
            ],
            "pagination": {"current_page": 1, "total_pages": 1},
        })
    )
    r = client.get("/invoices/unpaid?days_overdue=10", headers=auth_header)
    assert r.status_code == 200
    data = r.json()
    # Le plus en retard d'abord
    assert data[0]["id"] == 2
    assert data[0]["days_overdue"] >= data[1]["days_overdue"]


@respx.mock
def test_pennylane_500_returns_502(client, auth_header):
    respx.get("https://test-pennylane.local/api/external/v1/customers").mock(
        return_value=Response(500, text="Pennylane down")
    )
    r = client.get("/customers", headers=auth_header)
    # tenacity retry 3x puis raises → handler global → 502 (Bad Gateway upstream)
    assert r.status_code == 502
    assert "Pennylane" in r.json()["detail"]
