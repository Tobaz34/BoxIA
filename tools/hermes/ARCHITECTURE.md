# Architecture — AI Box franchise via Hermes Agent

> ADR consolidant la décision du **2026-05-13** de faire passer Hermes Agent au cœur du produit AI Box : agent autonome multi-canal (Telegram/WhatsApp/Email), multi-tenant (1 container par client), franchisé FR, branché sur les connecteurs et workflows BoxIA.

## 1. Décisions arbitrées

| # | Sujet | Décision |
|---|---|---|
| D1 | Rôle Hermes | **Façade conversationnelle** + agent autonome, **pas** central métier. BoxIA reste l'intelligence (connecteurs, workflows, RBAC, RGPD, audit). |
| D2 | UX client final | Canaux **messagerie d'abord** (Telegram → WhatsApp → Email). Le dashboard web `aibox-app` devient back-office admin. |
| D3 | Provider LLM | **Hybride** : cloud rapide (Claude Haiku ou Gemini Flash, latence <3 s) en défaut ; fallback local `qwen3:14b-64k` si offline ou donnée sensible (PII/santé). |
| D4 | Multi-tenant | **1 container Hermes par client** (isolation totale, ~200 Mo RAM/container, ~30-50 clients par serveur 32 Go). Profils Hermes mutualisés à envisager si scale >100 clients/serveur. |
| D5 | Franchise / brand | Fork léger `aibox-hermes:fr` : `SOUL.md` personnalisable par client, skills critiques traduites, prompts FR. Tag image par version `aibox-hermes:fr-v1.0`. |
| D6 | Approval gate | Tools mutatifs (envoi mail, création facture, suppression, dépense > seuil) **demandent confirmation Telegram** avant exec. Reprise du pattern `Concierge.decide` BoxIA. |
| D7 | Identité client ↔ tenant BoxIA | 1 bot Telegram = 1 tenant BoxIA. Mapping `TELEGRAM_BOT_TOKEN → tenant_id` dans `aibox-app` DB. SSO Telegram → web via pairing code à usage unique. |

## 2. Architecture cible

```
                      ┌─ Telegram bot       ─┐
                      ├─ WhatsApp number    ─┤
   Client TPE/PME ────┼─ Email IMAP/SMTP    ─┤  Canaux client
                      ├─ SMS (option)       ─┤
                      └─ Signal (option)    ─┘
                                │
                                ▼
                  ┌──────────────────────────────┐
                  │  Hermes Agent (aibox-hermes:fr) │
                  │  Container par tenant            │
                  │  Cloud LLM primary + local fb    │
                  │  Volume /srv/xefia/hermes_<tenant>│
                  └──────────────┬───────────────────┘
                                 │ tool-call (Bearer API)
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                   ▼
       BoxIA Concierge      Connecteurs FR       Skills Hermes
       (approval gate)      via aibox-app API    (kanban, cron, web,
                            (Pennylane, Odoo,    image gen, etc.)
                            GLPI, FEC, 3CX...)
              │                  │                   │
              └──────────────────┴───────────────────┘
                                 │
                                 ▼
                      aibox-app web (admin)
                  (config tenants, audit, RGPD,
                   pairing code Telegram, RBAC)
```

## 3. Points d'intégration critiques à résoudre

### I1 — Hermes container ↔ aibox-app (network)

**Problème observé 2026-05-13** : `aibox-app` est en `NetworkMode: host`, Hermes est sur `ollama_net`. Hermes **ne peut pas** joindre `aibox-app` par DNS. Toutes les routes `aibox-app` répondent **307** (redirect Authentik).

**Solutions à coder** :
1. Ajouter au compose Hermes :
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
   Permet `http://host.docker.internal:3100` depuis Hermes (Linux ≥20.10).
2. Créer endpoint **server-to-server** dans `aibox-app` : `/api/agent/tools/*` protégé par **API key partagé** (pas SSO), bypassant Authentik. Spec :
   - `POST /api/agent/concierge/decide` → décide d'un tool mutatif
   - `POST /api/agent/connectors/<slug>/call` → execute un connecteur
   - `GET  /api/agent/connectors` → liste les connecteurs disponibles pour le tenant
   - Header `X-AIBox-Agent-Key: <shared-secret>` + `X-AIBox-Tenant-Id: <tenant>`

### I2 — Multi-tenant : provisioning d'un client

**Variables par client** :
- `tenant_id` (slug : `boulangerie-martin`, `cabinet-dupont`...)
- `telegram_bot_token` (du BotFather, propre au client)
- `telegram_allowed_users` (chat_id Telegram du gérant + équipe)
- `hermes_api_key` (Bearer gateway, généré aléatoirement)
- `cloud_provider` + `cloud_api_key` (BYOK ou shared)
- `boxia_agent_key` (clé partagée pour I1)
- Volume dédié `/srv/xefia/hermes_<tenant_id>/data/`

**Script** : `tools/provision-hermes-client.sh <tenant_id>` (à créer ; squelette livré dans ce commit).

### I3 — Hybride cloud + local fallback

Hermes a un subcommand `hermes fallback` qui gère ça nativement :
```
hermes fallback add anthropic claude-haiku-4-5 --priority 1
hermes fallback add custom qwen3:14b-64k --base-url http://ollama:11434/v1 --priority 2
```
À automatiser dans le script de provisioning par tenant (selon BYOK ou pas).

### I4 — Approval gate Telegram pour tools mutatifs

Pattern proposé :
1. Skill BoxIA tagué `mutating: true` dans son SKILL.md
2. Avant tool-call mutatif, Hermes envoie message Telegram :
   > 🔒 *Action demandée* : Créer une facture Pennylane de 1 200 € pour client `Durand SARL`.
   > Répondre OK pour valider, NON pour annuler. Expire dans 5 minutes.
3. Hermes parse la réponse user, valide ou annule
4. Décision loggée dans audit BoxIA via `POST /api/agent/audit` (extension I1)

Hermes a déjà `hermes pairing` pour les codes d'authorization — à étendre/adapter pour le gating Telegram-flow.

## 4. Roadmap (rappel)

| Phase | Durée | Statut | Livrables |
|---|---|---|---|
| **P0** Hermes déployé + idempotent | ✅ | fait 2026-05-13 | Pipeline `tools/deploy-hermes-to-xefia.sh` |
| **P0.5** Cloud LLM hybride + Telegram POC | 1-2 j | en cours | Mode hybride dans le pipeline ; script `register-telegram-bot.sh` |
| **P1** Multi-tenant provisioning | 3-5 j | à faire | `provision-hermes-client.sh` + tenants isolés |
| **P2** Franchise FR + branding | 5-7 j | à faire | Image `aibox-hermes:fr` + SOUL.md customisable par tenant |
| **P3** Skills connecteurs BoxIA | 7-10 j | à faire | Skill bridge + endpoint `/api/agent/*` côté `aibox-app` |
| **P4** Autonomie sécurisée | continu | à faire | Approval gate Telegram + audit centralisé + heuristique confirm |

## 5. Économie franchise (ordre de grandeur)

- **Coûts variables/client/mois** (estimation usage normal) :
  - Cloud LLM (Claude Haiku ou Gemini Flash, ~500 messages/jour) : ~5-15 €/mois
  - Hosting (1/30e d'un serveur 32 Go RAM = ~30 €/mois → ~1 €/mois/client)
  - Bot Telegram : gratuit
- **Coûts fixes initiaux** : développement franchise (estimé 2-3 mois × 1 dev), serveurs.
- **Prix vente franchise** (ordre marché TPE/PME assistant IA) : 49-149 €/mois/client → marge confortable même en hybride cloud.

## 6. Décisions en attente (à arbitrer)

| # | Question |
|---|---|
| ? | BYOK (client paye sa conso Claude/Gemini) ou shared (toi tu paye et factures forfait) ? |
| ? | Quel modèle local pour le fallback : qwen3:14b-64k (qualité), qwen3:8b (vitesse), qwen2.5:14b (128K natif) ? |
| ? | Storage long terme audit/conversation : DB BoxIA partagée ou DB par tenant ? |
| ? | Stratégie reset/migration client (export volume → autre serveur) |

Ces points feront l'objet d'ADRs séparés au fil de P1-P4.
