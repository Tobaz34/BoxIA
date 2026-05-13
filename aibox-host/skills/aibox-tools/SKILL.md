---
name: aibox-tools
description: Bridge vers les microservices métier de l'AI Box (Pennylane comptabilité, et plus tard Odoo / GLPI / FEC / 3CX). À utiliser quand l'utilisateur demande des infos sur ses factures, clients, devis, fournisseurs, ou tickets.
version: 1.1.0
trigger_phrases:
  - facture
  - factures
  - impayé
  - impayés
  - relancer
  - relance
  - client
  - clients
  - devis
  - fournisseur
  - fournisseurs
  - comptabilité
  - pennylane
  - encaissement
  - en retard
requires_env:
  - AIBOX_HOST_IP           # IP LAN du serveur (192.168.x.y), set par install.sh
  - PENNYLANE_TOOL_API_KEY  # Bearer token pour appeler le microservice Pennylane
---

# Skill : aibox-tools

Hermes utilise ce skill pour appeler les **microservices métier** de l'AI Box.
Chaque microservice est un FastAPI Python autonome sur le réseau Docker
interne `aibox_net`, avec auth Bearer.

## Pennylane (comptabilité)

### Connexion

- **Endpoint LAN** : `http://aibox-conn-pennylane:8000` (depuis container Hermes sur `aibox_net`)
  ou `http://${AIBOX_HOST_IP}:8090` (depuis l'host)
- **Auth** : header `Authorization: Bearer ${PENNYLANE_TOOL_API_KEY}` (read-only, lecture seule)
- **Mode** : 100% read-only — aucun POST/PATCH/DELETE exposé pour la sécurité comptable.

### Endpoints disponibles (read-only)

| Méthode | Path | Paramètres | Usage |
|---|---|---|---|
| GET | `/healthz` | — | Healthcheck (pas d'auth) |
| GET | `/v1/info` | — | Info connecteur (version, tenant) |
| GET | `/customers` | `q=<search>`, `limit=20` | Liste/recherche de clients |
| GET | `/customers/{id}` | — | Détails 1 client |
| GET | `/invoices` | `status=`, `days_overdue=`, `limit=20` | Liste factures clients |
| GET | `/invoices/unpaid` | `days_overdue=30` | **Use case star** : impayés > N jours |
| GET | `/invoices/{id}` | — | Détails 1 facture |
| GET | `/quotes` | `status=`, `limit=20` | Liste devis |
| GET | `/supplier_invoices` | `status=`, `limit=20` | Factures fournisseurs |

### Exemples Python (via httpx, lib standard Hermes)

```python
import httpx, os

BASE = "http://aibox-conn-pennylane:8000"
HEADERS = {"Authorization": f"Bearer {os.environ['PENNYLANE_TOOL_API_KEY']}"}

# Impayés > 30 jours (le plus utile)
r = httpx.get(f"{BASE}/invoices/unpaid?days_overdue=30", headers=HEADERS, timeout=30)
unpaid = r.json()  # liste de factures impayées
# Format : [{id, customer_name, amount_cents, due_date, days_overdue, ...}, ...]

# Recherche client
r = httpx.get(f"{BASE}/customers?q=Durand&limit=5", headers=HEADERS, timeout=20)
customers = r.json()

# Factures d'un client (chercher d'abord, puis filtrer)
r = httpx.get(f"{BASE}/invoices?customer_id={customer_id}&limit=20", headers=HEADERS)
invoices = r.json()
```

### Flow Hermes typique

```
User (Telegram)  : "Quelles factures sont en retard de plus d'un mois ?"
Hermes          : appelle GET /invoices/unpaid?days_overdue=30
                  → liste 3 factures
Hermes répond   : "3 factures impayées dépassent 30 jours :
                   - Durand SARL : 1 200 € (échéance 12/03)
                   - Cabinet Martin : 850 € (échéance 25/03)
                   - SCI Lebrun : 4 500 € (échéance 02/04)
                   Total : 6 550 €. Veux-tu un récap par client ?"
```

### Pré-requis configuration

Pour activer Pennylane sur l'AI Box :

1. **Obtenir un Bearer token Pennylane** :
   - Connecte-toi à https://app.pennylane.com/
   - Paramètres → API → Génère un token (lecture)
2. **Ajouter à `/srv/ai-stack/.env`** :
   ```
   PENNYLANE_TOKEN=<token-pennylane-lecture>
   ```
   (le `PENNYLANE_TOOL_API_KEY` est déjà auto-généré par install.sh)
3. **Démarrer le microservice** :
   ```
   cd /srv/ai-stack/services/connectors/accounting-pennylane
   sudo docker compose up -d
   ```
4. **Vérifier** :
   ```
   docker logs aibox-conn-pennylane --tail 20
   curl http://localhost:8090/healthz  # → "ok"
   ```

### Garde-fous (à respecter ABSOLUMENT)

- **Aucun tool mutatif** sur Pennylane pour l'instant (Pas de création/modification de factures via Hermes). Si l'utilisateur demande "crée une facture", répondre : *"Pour créer une facture, fais-le directement dans Pennylane. Je peux par contre te résumer une facture existante ou te lister tes impayés."*
- **Montants** : toujours afficher en € (pas en centimes), arrondir à l'unité, formater FR (1 200 €, pas 1200.00 €).
- **Données client** : ne jamais inclure le SIRET, l'IBAN, ou un email client dans la mémoire mutualisée. Réponses one-shot OK, log d'audit oui mais pas mémoire long terme.
- **Erreur 401/403** : *"L'accès à Pennylane semble bloqué. Vérifie ton token dans /srv/ai-stack/.env (PENNYLANE_TOKEN)."*
- **Erreur 5xx** : *"Le service Pennylane est temporairement indisponible. Réessaie dans quelques minutes."*

## Odoo, GLPI, FEC, 3CX

Squelettes — à compléter quand creds disponibles (cf. PROJECT-BOARD S1.4 puis P2.5/P2.6/P2.7/P2.8) :

| Connecteur | Hostname interne | Port | Path | Status |
|---|---|---|---|---|
| Odoo (ERP) | `aibox-conn-odoo:8000` | 127.0.0.1:8092 | `/v1/partners`, `/v1/sale_orders`, `/v1/invoices` | ⬜ pending |
| GLPI (helpdesk) | `aibox-conn-glpi:8000` | 127.0.0.1:8093 | `/v1/tickets` | ⬜ pending |
| FEC import (compta) | `aibox-conn-fec:8000` | 127.0.0.1:8091 | `/v1/imports` POST + `/v1/imports/{id}` GET | ⬜ pending |
| 3CX (téléphonie) | `aibox-conn-3cx:8000` | 127.0.0.1:8094 | `/v1/calls`, `/v1/contacts` | ⬜ pending |

## Multi-user : qui parle ?

Hermes connaît le `chat_id` Telegram du user qui a déclenché la requête.
Inclure ce `chat_id` dans les logs d'audit pour chaque appel :

```python
audit_log = {
  "user_chat_id": ctx.telegram_chat_id,
  "user_name": ctx.user_first_name,
  "tool": "pennylane.invoices_unpaid",
  "params": {"days_overdue": 30},
  "timestamp": now(),
  "rows_returned": len(unpaid),
}
# Append à /opt/data/audit.jsonl
```
