---
name: aibox-tools
description: Bridge vers les microservices métier de l'AI Box (Pennylane comptabilité, Odoo ERP, GLPI helpdesk, FEC import, 3CX téléphonie). À utiliser quand l'utilisateur demande une action ou une consultation liée à ses outils professionnels.
version: 1.0.0
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
  - FEC
  - écritures comptables
  - chiffre d'affaires
  - impayé
requires_env:
  - AIBOX_AGENT_KEY            # shared secret (Bearer) pour appeler les microservices
  - AIBOX_CONNECTORS_ENABLED   # liste comma-sep des connecteurs activés
---

# Skill : aibox-tools

Hermes utilise ce skill pour parler aux **microservices métier** de l'AI Box : un par connecteur (Pennylane, Odoo, GLPI, FEC, 3CX). Chaque microservice est un FastAPI Python autonome, exposé sur le réseau Docker interne `aibox_net`, avec une authentification Bearer.

## Connecteurs disponibles (selon `AIBOX_CONNECTORS_ENABLED`)

| Connecteur | Hostname interne | Path racine | Actions principales |
|---|---|---|---|
| Pennylane (compta) | `aibox-connector-pennylane:8000` | `/v1/` | `/invoices` GET/POST, `/customers` GET, `/products` GET |
| Odoo (ERP) | `aibox-connector-odoo:8000` | `/v1/` | `/partners`, `/sale_orders`, `/invoices` |
| GLPI (helpdesk) | `aibox-connector-glpi:8000` | `/v1/` | `/tickets` GET/POST |
| FEC (import compta) | `aibox-connector-fec:8000` | `/v1/` | `/imports` POST (upload), `/imports/{id}` GET |
| 3CX (téléphonie) | `aibox-connector-3cx:8000` | `/v1/` | `/calls`, `/contacts` |

## Auth

Tous les microservices acceptent :
```
Authorization: Bearer ${AIBOX_AGENT_KEY}
```

Le `AIBOX_AGENT_KEY` est partagé entre Hermes et les microservices, généré au moment du wizard.

## Patterns d'usage

### Lister les factures impayées (Pennylane)

```python
import httpx, os
r = httpx.get(
    "http://aibox-connector-pennylane:8000/v1/invoices?status=unpaid",
    headers={"Authorization": f"Bearer {os.environ['AIBOX_AGENT_KEY']}"},
    timeout=30,
)
data = r.json()
# Format : [{ "id": "...", "customer": "...", "amount": 1200, "due_date": "..." }, ...]
```

### Créer une facture (tool mutatif → approval gate requise)

```
1. Demande à l'utilisateur tous les détails manquants (montant, client, lignes).
2. AVANT d'exécuter le POST, envoie un message Telegram :
   "🔒 Confirmer création facture Pennylane : 1200€ pour Durand SARL ?
    Réponds OUI pour valider, NON pour annuler."
3. Attends la réponse user (max 5 min).
4. Si OUI → POST l'action.
5. Si NON ou timeout → annule, message "Facture non créée."
6. Log l'action dans la mémoire (qui, quoi, quand, approval).
```

### Lister les tickets GLPI ouverts

```python
import httpx, os
r = httpx.get(
    "http://aibox-connector-glpi:8000/v1/tickets?status=open",
    headers={"Authorization": f"Bearer {os.environ['AIBOX_AGENT_KEY']}"},
    timeout=30,
)
```

## Garde-fous (à respecter ABSOLUMENT)

- **Actions mutatives** (POST, PUT, DELETE) → toujours **approval gate Telegram** avant exécution. Pattern : `tool POST = 2 messages user requis : 1) requête, 2) confirmation`.
- **Données sensibles** (numéros de compte, SIREN, IBAN, montants, données client) → ne JAMAIS les inclure dans la mémoire mutualisée entreprise. Réponse one-shot, log audit oui mais pas mémoire.
- **Si un connecteur retourne 401/403** → "L'accès au connecteur X semble bloqué. Vérifie la config dans le dashboard admin (http://localhost:3100)."
- **Si un connecteur retourne 5xx** → "Le service X est temporairement indisponible. Réessaie dans quelques minutes."
- **Si un connecteur n'est pas dans `AIBOX_CONNECTORS_ENABLED`** → "Le connecteur X n'est pas activé sur cette AI Box. Pour l'activer : relance le wizard."

## Multi-user : qui parle ?

Hermes connaît le `chat_id` Telegram du user qui a déclenché la requête. Inclure ce `chat_id` dans les logs d'audit pour chaque appel mutatif :

```python
audit_log = {
  "user_chat_id": ctx.telegram_chat_id,
  "user_name": ctx.user_first_name,
  "action": "pennylane.create_invoice",
  "params": {...},
  "timestamp": now(),
  "approval": "yes",
}
# POST vers /api/audit (à coder côté aibox-app, ou pour MVP stocké dans
# ~/.hermes/memories/audit.jsonl).
```

## Cas non couverts (TODO P3+)

- Approval gate inter-employés : si action > seuil €, demander confirmation patron (pas juste l'employé qui demande).
- Resync connecteurs : si l'admin a activé Pennylane après l'install, il faut re-source `.env` côté Hermes.
- Format des erreurs : standardiser tous les microservices à `{ "ok": false, "error": "...", "code": "..." }`.
