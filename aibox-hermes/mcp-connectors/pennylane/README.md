# MCP connecteur — Pennylane

Shim MCP (FastMCP) qui expose le microservice FastAPI Pennylane existant
(`services/connectors/accounting-pennylane`) en tools pour Hermes Agent.
**Lecture seule.** Hermes voit `mcp_pennylane_*`.

## Tools exposés

| Tool | Endpoint FastAPI | Rôle |
|---|---|---|
| `pennylane_health` | `/v1/info` | Santé / config |
| `list_unpaid_invoices` | `/invoices/unpaid` | ⭐ Impayés clients > N jours |
| `list_invoices` | `/invoices` | Factures clients |
| `get_invoice` | `/invoices/{id}` | Détail facture |
| `list_customers` | `/customers` | Clients |
| `get_customer` | `/customers/{id}` | Détail client |
| `list_quotes` | `/quotes` | Devis |
| `list_supplier_invoices` | `/supplier_invoices` | Factures fournisseurs |

## Test local

```bash
python -m venv .venv && . .venv/Scripts/activate   # (.venv/bin/activate sous Linux)
pip install -r requirements.txt
fastmcp inspect server.py:mcp          # le serveur importe + liste ses tools
fastmcp list server.py:mcp --json
# appel réel (nécessite le FastAPI Pennylane up + un vrai token) :
# PENNYLANE_TOOL_BASE_URL=http://127.0.0.1:8081 PENNYLANE_TOOL_API_KEY=xxx \
#   fastmcp call server.py:mcp list_unpaid_invoices days_overdue=30 --json
```

## Wiring dans Hermes (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  pennylane:
    command: "${TENANT_DIR}/mcp-connectors/pennylane/.venv/bin/python"
    args: ["${TENANT_DIR}/mcp-connectors/pennylane/server.py"]
    env:
      PENNYLANE_TOOL_BASE_URL: "http://127.0.0.1:8081"
      PENNYLANE_TOOL_API_KEY: "${env:PENNYLANE_TOOL_API_KEY}"
    timeout: 60
    tools:
      resources: false
      prompts: false
```

## Évolution possible

Pour réduire le nombre de processus, ce shim pourrait à terme appeler l'API
Pennylane en direct (en intégrant la normalisation du FastAPI) et retirer le
microservice. Pour le POC de dé-risquage, on réutilise le FastAPI éprouvé.
