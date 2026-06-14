# Port-map — BoxIA → AI Box Hermes-first

Chaque brique du moat BoxIA, où elle va, et son statut de portage. Source de vérité du « qu'est-ce qu'on garde / jette / réécrit ».

Légende statut : ⬜ à faire · 🟦 en cours · ✅ porté & validé · ♻️ réutilisé tel quel · 🗑️ abandonné

## Moat à porter (notre valeur)

| Asset BoxIA | Fichier source | Cible Hermes | Mécanisme | Statut |
|---|---|---|---|---|
| Approval-gate | `services/app/src/lib/approval-gate.ts` | `hooks/approval_gate.sh` | hook `pre_tool_call` | ⬜ |
| Scrub RGPD/PII FR | `services/app/src/lib/pii-scrub.ts` | `hooks/rgpd_scrub.sh` | hook `pre_api_request` | ⬜ |
| Connecteur Pennylane | `services/connectors/accounting-pennylane/` | `mcp-connectors/pennylane/` | shim MCP → FastAPI ♻️ | ⬜ |
| Connecteur Odoo | `services/connectors/erp-odoo/` | `mcp-connectors/odoo/` | shim MCP → FastAPI ♻️ | ⬜ |
| Connecteur GLPI | `services/connectors/helpdesk-glpi/` | `mcp-connectors/glpi/` | shim MCP → FastAPI ♻️ | ⬜ |
| Import FEC | `services/connectors/import-fec/` | `mcp-connectors/fec/` | shim MCP → FastAPI ♻️ | ⬜ |
| BYOK cloud + fallback | `services/app/src/lib/cloud-providers.ts` | `config.yaml` + `hermes fallback` | natif | ⬜ |
| Skills métier FR | `services/app/src/lib/boxia-fr-templates.ts` | `skills/aibox-fr/` | `skills.external_dirs` | ⬜ |
| Branding « AI Box » | Authentik brand + UI | `config/skins/aibox.yaml` + `SOUL.md` | `display.skin` | ⬜ |
| Provisioning tenant | `tools/provision-hermes-client.sh` | `provision/provision-tenant.sh` | script | ⬜ |
| Audit | `services/app/src/lib/app-audit.ts` | hook `post_tool_call` → JSONL | hook | ⬜ |

## Microservices connecteurs : réutilisés tels quels ♻️

Les FastAPI sous `services/connectors/*` **ne sont pas réécrits** — un shim MCP les enveloppe. Le Pennylane expose déjà : `/invoices/unpaid`, `/invoices`, `/customers`, `/quotes`, `/supplier_invoices` (read-only, bearer auth). Le shim mappe 1 endpoint → 1 tool MCP.

## Abandonné 🗑️ (la colle, remplacée par Hermes natif)

| Brique | Pourquoi |
|---|---|
| Dify (moteur d'agent + chat) | Remplacé par la boucle agent Hermes |
| Chat UI Next.js (`services/app`) | Remplacé par multi-canal Hermes (Telegram/WhatsApp/web) |
| Endpoints `/api/agent/*` | Jamais codés ; le chemin MCP direct les rend inutiles |
| Synchro multi-DB Dify/n8n/Authentik | Plus de Dify ; n8n optionnel ; auth = pairing Hermes |
| Migrations multi-DB (`tools/migrations/`) | Liées à Dify/n8n ; obsolètes hors de ces moteurs |
| Bridge `tools/hermes/skills/boxia-tools` | Architecture HTTP→aibox-app remplacée par MCP direct |

## À trancher plus tard ❓

| Question | Note |
|---|---|
| Garde-t-on n8n pour les workflows planifiés ? | Hermes a `cronjob` natif + MCP n8n officiel si besoin |
| Garde-t-on Authentik pour l'admin web ? | Peut-être superflu en mono-tenant ; pairing Telegram suffit pour les employés |
| RAG (Qdrant) | Hermes a sa mémoire ; le RAG docs peut devenir un MCP ou un skill |
