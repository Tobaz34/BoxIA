# Quickstart POC — valider la tranche Pennylane bout-en-bout

> Ferme le **critère go/no-go #3** (latence hybride + E2E live). À lancer sur
> **Linux / WSL2 / xefia** — Hermes ne tourne pas en natif Windows (Linux/macOS/WSL2).
> Durée ~20 min. Aucun secret à committer.

## 0. Pré-requis
- Ollama lancé avec un modèle (`ollama pull qwen3:14b`)
- Le microservice FastAPI Pennylane up (ou un mock) sur `http://127.0.0.1:8081`
  — pour tester sans Pennylane réel, n'importe quel endpoint renvoyant du JSON suffit
- Python 3.11+

## 1. Installer Hermes (vierge)
```bash
curl -fsSL https://hermes-agent.org/install.sh | bash   # ou: pipx install hermes-agent
export HERMES_HOME="$HOME/.hermes-aibox-poc"             # tenant isolé pour le POC
```

## 2. Brancher notre couche produit
```bash
REPO=/chemin/vers/IA_TPE_PME_POWER
cd "$REPO/aibox-hermes"

# Plugins (auto-découverts par Hermes)
mkdir -p "$HERMES_HOME/plugins"
ln -s "$REPO/aibox-hermes/plugins/aibox-approval" "$HERMES_HOME/plugins/aibox-approval"
ln -s "$REPO/aibox-hermes/plugins/aibox-rgpd"     "$HERMES_HOME/plugins/aibox-rgpd"

# venv du shim MCP Pennylane
cd mcp-connectors/pennylane
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/fastmcp list server.py:mcp --json     # doit lister 8 tools
```

## 3. Config (`$HERMES_HOME/config.yaml`)
Partir de `config/config.template.yaml`, substituer `${TENANT_DIR}` →
`$REPO/aibox-hermes`. Minimum pour le POC :
```yaml
model:
  provider: "custom"
  base_url: "http://127.0.0.1:11434/v1"
  default: "qwen3:14b"
mcp_servers:
  pennylane:
    command: "REPO/aibox-hermes/mcp-connectors/pennylane/.venv/bin/python"
    args: ["REPO/aibox-hermes/mcp-connectors/pennylane/server.py"]
    env:
      PENNYLANE_TOOL_BASE_URL: "http://127.0.0.1:8081"
      PENNYLANE_TOOL_API_KEY: "${env:PENNYLANE_TOOL_API_KEY}"
    tools: { resources: false, prompts: false }
```
`$HERMES_HOME/.env` :
```
PENNYLANE_TOOL_API_KEY=...
AIBOX_RGPD_SCRUB=1
AIBOX_MUTATING_TOOLS_REGEX=.*_create.*|.*create_.*|.*_update.*|.*_delete.*|.*_send.*|.*_pay.*|.*_refund.*|.*_cancel.*
```

## 4. Tests E2E
```bash
hermes hooks doctor          # plugins chargés ?
hermes                       # CLI interactive
```
- **MCP** : « Liste mes factures clients impayées de plus de 30 jours »
  → l'agent appelle `mcp_pennylane_list_unpaid_invoices` → réponse.
- **Approval** : déclencher un tool mutatif (ex. ajouter temporairement un faux
  tool `..._create_*`) → l'agent est bloqué, annonce `/aibox-approve <id>` →
  envoyer `/aibox-approve <id>` → redemander → exécution.
- **RGPD** : faire renvoyer au connecteur un IBAN/email → vérifier les `[..._REDACTED]`
  dans les logs (`AIBOX_RGPD_SCRUB=1`).

## 5. Critère #3 — latence
```bash
# local (qwen3:14b) : noter le temps de réponse (~24-48 s attendu)
# puis cloud :
hermes fallback add anthropic claude-haiku-4-5 --priority 1   # ANTHROPIC_API_KEY dans .env
# re-tester : latence attendue ~1-2 s
```
**Go** si : MCP répond avec de vraies données, approval bloque/débloque, scrub
visible, et la latence cloud est < 3 s. → on enchaîne Phase 2.
```
```
