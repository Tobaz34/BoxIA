"""Smoke E2E du shim MCP Pennylane.

Prouve le chemin de données COMPLET, sans Hermes ni Pennylane réel :
  client FastMCP (in-memory) -> tool MCP -> httpx -> FastAPI (mock) -> JSON -> retour MCP

Run :  python smoke_e2e.py
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8765

FAKE: dict[str, object] = {
    "/v1/info": {"service": "mock-pennylane", "version": "test", "tenant": "poc"},
    "/invoices/unpaid": [
        {"id": 1, "invoice_number": "F-2026-001", "customer_name": "Durand SARL",
         "amount_eur": 1200.0, "days_overdue": 45, "status": "upcoming"},
        {"id": 2, "invoice_number": "F-2026-002", "customer_name": "Martin SAS",
         "amount_eur": 800.0, "days_overdue": 31, "status": "upcoming"},
    ],
    "/customers/42": {"id": 42, "name": "Durand SARL", "email": "compta@durand.fr",
                      "siren": "732829320"},
}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # silence
        pass

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        body = FAKE.get(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _serve() -> None:
    HTTPServer(("127.0.0.1", PORT), _Handler).serve_forever()


# Env AVANT l'import du serveur (il lit l'env à l'import).
os.environ["PENNYLANE_TOOL_BASE_URL"] = f"http://127.0.0.1:{PORT}"
os.environ["PENNYLANE_TOOL_API_KEY"] = "test-key"

threading.Thread(target=_serve, daemon=True).start()
time.sleep(0.3)

import server  # noqa: E402
from fastmcp import Client  # noqa: E402


def _payload(r):
    for attr in ("data", "structured_content"):
        v = getattr(r, attr, None)
        if v is not None:
            return v
    content = getattr(r, "content", None)
    if content:
        txt = getattr(content[0], "text", None)
        if txt:
            try:
                return json.loads(txt)
            except Exception:
                return txt
    return r


async def main() -> None:
    async with Client(server.mcp) as c:
        tools = await c.list_tools()
        print(f"tools exposés : {len(tools)}")

        await c.call_tool("pennylane_health", {})
        unpaid = _payload(await c.call_tool("list_unpaid_invoices", {"days_overdue": 30, "limit": 5}))
        cust = _payload(await c.call_tool("get_customer", {"customer_id": "42"}))

        print("impayés :", json.dumps(unpaid, ensure_ascii=False)[:160])
        assert isinstance(unpaid, list) and len(unpaid) == 2, unpaid
        assert unpaid[0]["customer_name"] == "Durand SARL", unpaid[0]
        assert cust["name"] == "Durand SARL", cust
        print("OK E2E : health + impayes(2) + client round-trip via le shim MCP")


if __name__ == "__main__":
    asyncio.run(main())
