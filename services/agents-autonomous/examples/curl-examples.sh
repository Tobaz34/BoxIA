#!/usr/bin/env bash
# =============================================================================
# Exemples curl pour tester les 3 agents en local
# =============================================================================
# Usage : AGENTS_API_KEY=xxx ./examples/curl-examples.sh
# =============================================================================
set -euo pipefail

URL="${AGENTS_URL:-http://127.0.0.1:8085}"
KEY="${AGENTS_API_KEY:?AGENTS_API_KEY required}"

hr() { printf '%.0s─' {1..60}; printf '\n'; }

# =========================================================================
hr; echo "1. /v1/info (no auth)"; hr
curl -s "$URL/v1/info" | python3 -m json.tool

# =========================================================================
hr; echo "2. /v1/triage-email"; hr
curl -s -X POST "$URL/v1/triage-email" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "sender": "marie.dupont@acme-textile.fr",
    "sender_name": "Marie Dupont",
    "subject": "Demande de devis pour création site e-commerce",
    "body": "Bonjour, nous sommes une PME bio (12 salariés). Nous souhaitons créer un site e-commerce avec catalogue 150 réfs, paiement Stripe, espace client, multilingue FR/EN, livraison sous 8 semaines.",
    "received_at": "2026-04-30T14:30:00",
    "has_attachments": false
  }' | python3 -m json.tool

# =========================================================================
hr; echo "3. /v1/generate-quote"; hr
curl -s -X POST "$URL/v1/generate-quote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "brief": "Création site e-commerce textile bio (catalogue 150 références, Stripe + virement, espace client, multilingue FR/EN, responsive, livraison 8 semaines).",
    "customer": {
      "name": "Marie Dupont",
      "email": "marie.dupont@acme-textile.fr",
      "company": "Acme Textile SARL"
    },
    "company_context": "Agence web. Tarifs : dev web 600€/jour, intégration 500€/jour. Spécialité Shopify.",
    "vat_rate_percent": 20.0,
    "valid_until_days": 30
  }' | python3 -m json.tool

# =========================================================================
hr; echo "4. /v1/reconcile-invoice"; hr
curl -s -X POST "$URL/v1/reconcile-invoice" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "invoice_type": "fournisseur",
    "invoice_text": "FACTURE N° FA-2026-0427\nDate : 15/04/2026\nFournisseur : OVH SAS - SIRET 42476141900045\nClient : Xefia SARL\nRéférence commande : CMD-2026-089\n\nServeur dédié RISE-LE 2024  1  89.99  89.99\nVMware vSAN add-on            1  45.00  45.00\n\nTotal HT  : 134.99 €\nTVA 20%   : 27.00 €\nTotal TTC : 161.99 €",
    "candidates": [
      {
        "candidate_id": "PO-2026-089",
        "candidate_type": "purchase_order",
        "amount_eur": "161.99",
        "date": "2026-04-15",
        "reference": "CMD-2026-089",
        "score": 0,
        "delta_eur": "0",
        "delta_days": 0
      }
    ]
  }' | python3 -m json.tool
