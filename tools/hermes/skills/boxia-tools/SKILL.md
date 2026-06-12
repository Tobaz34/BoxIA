---
name: boxia-tools
description: Bridge vers l'écosystème AI Box (BoxIA) — accès aux connecteurs métier (Pennylane comptabilité, Odoo ERP, GLPI helpdesk, FEC import, 3CX téléphonie, etc.) et au Concierge d'approbation. À utiliser quand l'utilisateur demande une action métier impliquant ses outils professionnels (facturation, devis, contacts, tickets, appels...).
version: 0.1.0
trigger_phrases:
  - facture
  - devis
  - client
  - comptabilité
  - pennylane
  - odoo
  - glpi
  - ticket
  - téléphonie
  - 3cx
  - bilan
  - tva
  - urssaf
requires_env:
  - BOXIA_AGENT_KEY    # shared secret server-to-server
  - BOXIA_TENANT_ID    # tenant côté aibox-app
  - BOXIA_API_BASE     # ex: http://host.docker.internal:3100/api/agent
mutating_tool_pattern: '/api/agent/connectors/.+/call'
---

# Skill : boxia-tools

Ce skill connecte Hermes Agent à la plateforme **AI Box** (BoxIA) pour exécuter des actions métier via les connecteurs déjà configurés côté `aibox-app`.

## Quand utiliser ce skill

Quand l'utilisateur demande une action liée à ses **outils métier** :

- Créer / lister / modifier une **facture** ou un **devis** (Pennylane, Odoo)
- Rechercher un **client** dans le CRM (Odoo)
- Créer / consulter un **ticket** support (GLPI)
- Importer un **FEC** (Fichier des Écritures Comptables)
- Consulter / déclencher un **appel téléphonique** (3CX)
- Demander un **bilan**, état de TVA, échéance URSSAF
- Toute action impliquant les outils pros du client

## Outils exposés par BoxIA

Le bridge utilise 3 endpoints server-to-server protégés par `X-AIBox-Agent-Key` :

### 1. Lister les connecteurs disponibles pour le tenant

```
GET ${BOXIA_API_BASE}/connectors
Headers:
  X-AIBox-Agent-Key: ${BOXIA_AGENT_KEY}
  X-AIBox-Tenant-Id: ${BOXIA_TENANT_ID}

Response:
[
  {"slug": "pennylane", "name": "Pennylane", "enabled": true, "actions": ["create_invoice", "list_invoices", ...]},
  {"slug": "odoo",      "name": "Odoo",      "enabled": true, "actions": ["search_partner", ...]},
  ...
]
```

### 2. Appeler un connecteur

```
POST ${BOXIA_API_BASE}/connectors/<slug>/call
Headers:
  X-AIBox-Agent-Key: ${BOXIA_AGENT_KEY}
  X-AIBox-Tenant-Id: ${BOXIA_TENANT_ID}
  Content-Type: application/json

Body:
{
  "action": "create_invoice",
  "params": { "client_id": "...", "amount": 1200, ... },
  "approval_token": "<obtained via /api/agent/concierge/decide if mutating>"
}

Response success:
{ "ok": true, "result": {...} }

Response approval required (HTTP 403):
{ "ok": false, "code": "approval_required", "decide_url": "/api/agent/concierge/decide", "challenge": "...", "human_summary": "Créer facture Pennylane 1200€ pour Durand SARL" }
```

### 3. Demander approbation Concierge (pour tool mutatif)

```
POST ${BOXIA_API_BASE}/concierge/decide
Headers:
  X-AIBox-Agent-Key: ${BOXIA_AGENT_KEY}
  X-AIBox-Tenant-Id: ${BOXIA_TENANT_ID}

Body:
{
  "action": "pennylane.create_invoice",
  "params": {...},
  "human_summary": "Créer facture 1200€ pour Durand SARL",
  "telegram_chat_id": "<chat_id du user qui a déclenché>"
}

Response:
{ "approval_token": "...", "expires_at": "2026-05-13T15:00:00Z" }

Hermes envoie alors un message Telegram au user demandant confirmation, attend
réponse OK/NON, puis ré-appelle l'action avec l'approval_token.
```

## Flow standard d'invocation

```
User (Telegram) : "Crée une facture de 1200€ pour Durand SARL"
                      │
                      ▼
Hermes (skill boxia-tools)
  1. GET /connectors → trouve pennylane est enabled, a create_invoice
  2. POST /connectors/pennylane/call → 403 approval_required + human_summary
  3. POST /concierge/decide → approval_token + send_telegram_msg
  4. Hermes envoie Telegram : "🔒 Confirmer : créer facture 1200€ Durand SARL ? OK / NON"
  5. User répond "OK"
  6. Hermes ré-appelle POST /connectors/pennylane/call avec approval_token
  7. → 200 OK, facture créée
  8. Hermes répond : "✓ Facture #2026-042 créée pour Durand SARL"
```

## Garde-fous

- **Ne JAMAIS** exécuter un tool mutatif sans approval_token.
- Si le user demande une action sans préciser un montant/client/etc., demander avant d'appeler.
- Si `BOXIA_AGENT_KEY` n'est pas défini, signaler à l'utilisateur que le bridge BoxIA n'est pas configuré (ne pas inventer de réponse).
- Logger chaque appel mutatif dans la mémoire Hermes (qui, quoi, quand) pour pouvoir répondre "qu'est-ce que j'ai fait pour ce client aujourd'hui ?"

## Statut d'implémentation (2026-05-13)

⚠ **Squelette en attente d'implémentation côté `aibox-app`** :

- [ ] Endpoint `GET  /api/agent/connectors` (extension `aibox-app`)
- [ ] Endpoint `POST /api/agent/connectors/<slug>/call`
- [ ] Endpoint `POST /api/agent/concierge/decide`
- [ ] Auth par `X-AIBox-Agent-Key` (shared secret, pas SSO Authentik)
- [ ] Mapping `tenant_id` ↔ tenant Authentik

Tant que ces endpoints n'existent pas, ce skill peut servir de **placeholder fonctionnel** pour tester le flow de tool-call + Telegram approval, en mockant les endpoints localement.

## Test rapide (sans aibox-app endpoint)

```bash
# Simule une réponse via curl httpbin (Hermes verra une 200 avec des données)
docker exec hermes /opt/hermes/.venv/bin/hermes chat \
  -z "Liste les connecteurs disponibles" \
  --skills boxia-tools
```
