# AI Box — Project Board

> Document maître de pilotage projet. À lire en début de chaque session.
> **Source de vérité unique** pour : qui fait quoi, quand, où on en est.
>
> Maintenu par le PM (Claude en mode pilotage projet). Toute évolution = commit avec message `proj(board): <changement>`.

📍 **État courant** (2026-05-13) : Phase 0 ✅ (install validé sur xefia) → début Sprint 1 (Quick wins MVP).

---

## 📑 Sommaire

1. [Project Charter](#1-project-charter)
2. [Méthode & cadence](#2-méthode--cadence)
3. [Sprint courant (S1)](#3-sprint-courant-s1)
4. [Backlog complet (WBS)](#4-backlog-complet-wbs)
5. [Risk Register](#5-risk-register)
6. [Decision Log (ADR-lite)](#6-decision-log-adr-lite)
7. [KPIs & Definition of Done](#7-kpis--definition-of-done)
8. [Glossaire](#8-glossaire)
9. [Comment utiliser ce board](#9-comment-utiliser-ce-board)

---

## 1. Project Charter

### Vision
> **Le concierge IA de la TPE/PME française.** 1 PC dédié installé chez le client. Le patron + ses employés interrogent leur AI Box via Telegram/WhatsApp/Email/web. L'AI Box répond, consulte leurs outils métier (Pennylane, Odoo, GLPI…), déclenche des actions. 100% local + cloud LLM hybride (RGPD safe + latence < 3s).

### Périmètre IN

- Installer one-command pour PC Ubuntu vierge
- Stack BoxIA (Authentik / Dify / n8n / Postgres / Ollama / aibox-app / monitoring)
- Hermes Agent en concierge multi-canal
- 5 connecteurs métier FR (Pennylane / Odoo / GLPI / FEC / 3CX)
- Multi-user intra-entreprise (~2-10 employés)
- Telegram (P1) + Email (P2) + WhatsApp (P3)
- Backup auto + update à distance + monitoring
- Franchise reproductible (3 clients déployés indépendamment)

### Périmètre OUT (explicite)

- Multi-tenant cross-entreprise sur un serveur central
- Cloud SaaS (toujours on-premise PC client)
- Modèles fine-tunés custom
- Mobile apps natives iOS/Android (PWA seulement)
- Conformité ISO 27001 / SOC2 (RGPD seulement)
- Support N1 24/7 (heures de bureau uniquement)

### Stakeholders

| Rôle | Personne | Responsabilités |
|---|---|---|
| **Sponsor / Owner** | Andre (clikinfo) | Vision produit, arbitrages, business model |
| **PM** | Claude (sessions Claude Code) | Découpage, planning, exécution, doc |
| **Dev** | Claude + Andre | Code, tests, déploiement |
| **Client pilote** | TBD (à recruter) | Feedback usage réel, NPS |
| **Commercial** | TBD (à former post-P6) | Onboarding nouveaux clients |

### Success Criteria (12-16 sem)

1. ✅ Install reproductible : 3 clients déployés indépendamment par 3 personnes différentes en < 1h chacun.
2. ✅ Latence : 95e percentile chat < 5s en mode cloud BYOK.
3. ✅ Connecteurs : 5/5 connecteurs FR fonctionnels E2E avec actions mutatives validées.
4. ✅ Adoption : 1 client pilote utilise AI Box > 10 fois/semaine pendant 1 mois.
5. ✅ NPS pilote ≥ 7/10 après 1 mois.
6. ✅ Fiabilité : 30 jours d'usage sans intervention manuelle.
7. ✅ Documentation : USER-GUIDE.md + vidéo 5 min publiables.

---

## 2. Méthode & cadence

### Méthode
- **Agile / Kanban allégé** avec sprints fixes 2 semaines.
- **WBS hiérarchique** : Phase → Epic → Story → Task (atomique <0.5j).
- **TodoWrite** dans chaque session pour le tracking court terme.
- **Ce fichier** pour le tracking long terme + cross-session.

### Cadence
- **Sprint = 2 semaines.**
- **Sprint Planning** : début de sprint, choix 5-10 j-h de tâches dans backlog.
- **Daily** : check rapide au début de chaque session Claude (lire ce board).
- **Retro + Demo** : fin de sprint, valider critères de sortie, MAJ backlog.

### Vélocité estimée
- 1 j-h = 1 jour-homme effectif (focus dev, hors meetings).
- Vélocité cible : 8-10 j-h / semaine en plein temps (vacances/aléas inclus).
- Donc **1 sprint = 16-20 j-h**.

### États possibles d'une tâche
| État | Symbole | Sens |
|---|---|---|
| pending | ⬜ | Dans le backlog, pas encore commencé |
| ready | 🟦 | Pré-requis OK, peut être attaqué |
| in_progress | 🚧 | En cours, owner assigné |
| review | 🟡 | Code écrit, attend test/validation |
| done | ✅ | Critère d'acceptation rempli |
| blocked | ❌ | Bloqué par une dépendance externe |
| cancelled | ⛔ | Abandonné (avec raison) |

### Priorités
- 🔴 **P0** : critique, bloque le sprint
- 🟠 **P1** : important, à faire dans le sprint
- 🟢 **P2** : nice-to-have, peut glisser au sprint suivant

---

## 3. Sprint courant (S1)

📅 **S1 — Quick wins MVP** | 2026-05-13 → 2026-05-27 | **5 j-h** estimés

### Goal
> Au sortir du sprint, l'AI Box répond < 5s, le RAG marche sur 5 docs métier, Telegram fonctionne, Pennylane connecté E2E, et les 7 bugs install sont fixés.

### Backlog Sprint 1

| ID | Tâche | Priorité | Effort | État | Owner |
|---|---|---|---|---|---|
| S1.1 | Activer Cloud LLM hybride Anthropic Haiku | 🔴 P0 | 1 j | 🟦 ready | Andre + Claude |
| S1.2 | Test RAG : upload 5 docs métier + 10 questions | 🔴 P0 | 1 j | ⬜ pending | Andre |
| S1.3 | Activer bot Telegram + test E2E Hermes | 🔴 P0 | 0.5 j | ⬜ pending | Andre (BotFather) + Claude |
| S1.4 | Test E2E Pennylane connector | 🟠 P1 | 1 j | ⬜ pending | Andre (creds) + Claude |
| S1.5 | Fix 7 bugs install (admin_email, NEXTAUTH_URL, etc.) | 🟠 P1 | 2 j | 🟡 review | Claude |

### Risque Sprint 1
- 🔴 **R-S1-01** : clé Anthropic non disponible → S1.1 bloqué → cascade S1.2/S1.4 (rester en local 30s, NPS pilote naze)
- 🟠 **R-S1-02** : compte Pennylane sandbox non accessible → S1.4 glisse au sprint suivant
- 🟢 **R-S1-03** : 7 bugs install plus complexes que prévus → étalement sur S2

### Definition of Done Sprint 1
- [ ] 3 chats successifs depuis aibox-app, latence < 5s chacun (S1.1)
- [ ] RAG répond correctement à 7/10 questions sur les docs uploadés (S1.2)
- [ ] Bot Telegram répond à 3 messages tests d'un user whitelisté (S1.3)
- [ ] Pennylane retourne au moins une liste de factures via Hermes skill (S1.4)
- [ ] Fresh install propre sur Ubuntu vierge OU validé sur xefia sans patch manuel (S1.5)

---

## 4. Backlog complet (WBS)

### 🚀 EPIC P1 — Quotidien fonctionnel (Sprint 1)

#### Story P1.1 — Cloud LLM hybride Anthropic Haiku
**User story** : En tant que client TPE, je veux des réponses < 5s pour utiliser AI Box quotidiennement.
**Effort** : 1 j | **Priorité** : 🔴 P0 | **État** : 🟦 ready

| Task | Effort | État | Notes |
|---|---|---|---|
| P1.1.1 — Andre obtient clé Anthropic Console (https://console.anthropic.com/settings/keys) | 5 min | ⬜ | Action user |
| P1.1.2 — Ajouter `ANTHROPIC_API_KEY=sk-ant-...` dans `/opt/aibox/hermes/.env` | 5 min | ⬜ | sed -i |
| P1.1.3 — Configurer Hermes : provider anthropic, model claude-haiku-4-5-20251001 | 10 min | ⬜ | `hermes config set` |
| P1.1.4 — Configurer fallback local qwen3:14b-64k via `hermes fallback add` | 10 min | ⬜ | priority 2 |
| P1.1.5 — Configurer Dify agents (general, vision) avec Anthropic via OpenAI-compat | 1 h | ⬜ | UI Dify ou API |
| P1.1.6 — Restart Hermes + Dify worker | 5 min | ⬜ | docker compose restart |
| P1.1.7 — Test E2E : 3 chats Hermes API, latence < 5s | 30 min | ⬜ | curl chat completions |
| P1.1.8 — Test E2E : login web + chat depuis dashboard, < 5s | 30 min | ⬜ | Chrome MCP |
| P1.1.9 — Test fallback : couper internet → vérifier qwen3 prend le relais | 30 min | ⬜ | iptables ou block DNS |
| P1.1.10 — Documenter la conso $$ (Langfuse traces) | 30 min | ⬜ | sample 100 chats |

**Acceptance** : 3 chats < 5s + fallback testé + conso documentée

#### Story P1.2 — Test RAG documents métier
**User story** : En tant qu'admin TPE, je veux uploader 5 documents pros et poser des questions dessus pour valider l'utilité quotidienne.
**Effort** : 1 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending
**Dépendances** : P1.1 (latence acceptable)

| Task | Effort | État | Notes |
|---|---|---|---|
| P1.2.1 — Préparer 5 PDF métier représentatifs (facture, devis, contrat, fiche produit, bulletin paie) | 1 h | ⬜ | Anonymisés ou bidons |
| P1.2.2 — Upload via aibox-app /Documents (UI) | 30 min | ⬜ | Test UI |
| P1.2.3 — Vérifier indexation Qdrant (vectorisation OK) | 15 min | ⬜ | API Qdrant |
| P1.2.4 — Rédiger 10 questions cibles (5 directes, 5 inférentielles) | 1 h | ⬜ | Liste fixe pour repro |
| P1.2.5 — Tester les 10 questions sur Assistant général avec RAG actif | 1 h | ⬜ | Chronométrer |
| P1.2.6 — Scoring : noter 0/1 par question (juste/faux) | 30 min | ⬜ | Cible 7/10 |
| P1.2.7 — Identifier les failures + log dans Decision Log | 1 h | ⬜ | Comprendre patterns |

**Acceptance** : 7/10 questions OK, log des 3 fails avec analyse

#### Story P1.3 — Migrations Dify retry mechanism
**User story** : En tant qu'install one-command, je veux que les migrations Dify se rejouent automatiquement quand Dify devient ready.
**Effort** : 0.5 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending

| Task | Effort | État | Notes |
|---|---|---|---|
| P1.3.1 — Lire `tools/migrations/run-pending.py` | 15 min | ⬜ | Comprendre le code existant |
| P1.3.2 — Ajouter retry loop avec backoff exponentiel (max 5 tentatives, 30/60/120/240/480s) | 1.5 h | ⬜ | Sur Connection refused |
| P1.3.3 — Tester sur xefia : forcer migration sur Dify down, vérifier retry | 30 min | ⬜ | docker stop dify-api |
| P1.3.4 — Intégrer dans aibox-install.sh post-deploy | 30 min | ⬜ | Boucle attente Dify healthcheck |
| P1.3.5 — Commit + push | 15 min | ⬜ | |

**Acceptance** : 12 migrations Dify passent en 1ère tentative après fresh install

#### Story P1.4 — Fix bugs pipeline install (7 bugs P1 identifiés)
**User story** : En tant qu'install one-command, je veux pas avoir besoin de patches manuels pour qu'aibox-app fonctionne en LAN.
**Effort** : 2 j | **Priorité** : 🟠 P1 | **État** : 🟡 review (code done, test fresh install pending)

| Task | Effort | État | Commit |
|---|---|---|---|
| P1.4.1 — Fix `/api/configure` : propager `admin_password` vers create-admin-user | 1 h | ✅ | déjà OK dans le code existant (payload.admin_password ligne 504) ; vrai bug = install.sh bootstrap écrasait après → fix 5054e66 |
| P1.4.2 — Fix `/api/configure` : générer admin_email depuis payload, pas DOMAIN .env | 1 h | ✅ | déjà OK (payload.admin_email ligne 503) ; vrai bug = idem → fix 5054e66 |
| P1.4.3 — Auto-détection IP LAN dans NEXTAUTH_URL | 2 h | ✅ | `5054e66` (install.sh) + `e16376c` (/api/configure) |
| P1.4.4 — Auto-détection IP dans AUTHENTIK_APP_ISSUER | 30 min | ✅ | idem `5054e66` + `e16376c` |
| P1.4.5 — Authentik OIDC : ajouter IP LAN au redirect_uris auto via provision-sso | 1.5 h | ✅ | `2a68cfa` (utilise AIBOX_HOST_IP du .env, pas Host header) |
| P1.4.6 — Compose Ollama : `external: true` retiré pour fresh install | 1 h | ✅ | `c570b9d` (volume créé si absent, name `anythingllm_ollama_data` préservé pour compat) |
| P1.4.7 — Test fresh install sur xefia post-fix | 2 h | ⬜ pending | exige autorisation user pour wipe (destructive) |
| P1.4.8 — Commits atomiques + push | 30 min | ✅ | 4 commits poussés `5054e66`, `e16376c`, `2a68cfa`, `c570b9d` |

**Acceptance** : Fresh install xefia complète sans aucun patch manuel runtime — **à valider via P1.4.7 (test)**

#### Story P1.5 — Quick wins UX
**User story** : Comme user web, je veux des éléments d'UI évidents (logout, breadcrumbs).
**Effort** : 0.5 j | **Priorité** : 🟢 P2 | **État** : ⬜ pending

| Task | Effort | État |
|---|---|---|
| P1.5.1 — Audit UI aibox-app : logout visible ? fil d'Ariane ? | 1 h | ⬜ |
| P1.5.2 — Ajouter bouton logout sidebar si manquant | 1 h | ⬜ |
| P1.5.3 — Fil d'Ariane sur les pages internes | 2 h | ⬜ |

**Acceptance** : Logout cliquable depuis n'importe quelle page

---

### 🔌 EPIC P2 — Connecteurs métier opérationnels (Sprint 2-3)

#### Story P2.1 — Activer Telegram Hermes
**User story** : Comme employé TPE, je veux demander une info à AI Box depuis mon téléphone via Telegram.
**Effort** : 0.5 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending

| Task | Effort | État |
|---|---|---|
| P2.1.1 — Andre crée bot via @BotFather, note le token | 5 min | ⬜ |
| P2.1.2 — Andre `/start` au bot pour avoir son chat_id | 5 min | ⬜ |
| P2.1.3 — Lancer `tools/register-telegram-bot.sh <token>` (ou patcher .env manuellement) | 10 min | ⬜ |
| P2.1.4 — Restart Hermes | 5 min | ⬜ |
| P2.1.5 — Test : 3 messages depuis Telegram, attendre réponse | 30 min | ⬜ |
| P2.1.6 — Test multi-user : ajouter Marie au TELEGRAM_ALLOWED_USERS | 30 min | ⬜ |

**Acceptance** : Andre + Marie reçoivent réponses Hermes Telegram en < 10s

#### Story P2.2 — Test Pennylane microservice
**User story** : Hermes peut appeler Pennylane pour lister/créer des factures.
**Effort** : 1 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending

| Task | Effort | État | Notes |
|---|---|---|---|
| P2.2.1 — Lire le code microservice `services/connectors/accounting-pennylane/app/main.py` | 30 min | ⬜ | Comprendre routes |
| P2.2.2 — Obtenir clé API sandbox Pennylane (Andre) | 1 h | ⬜ | Action user |
| P2.2.3 — Démarrer container `aibox-connector-pennylane` | 30 min | ⬜ | Via compose ou manuel |
| P2.2.4 — Test direct via curl Bearer : `GET /v1/invoices?status=unpaid` | 30 min | ⬜ | Validation HTTP |
| P2.2.5 — Test `GET /v1/customers` | 15 min | ⬜ | |
| P2.2.6 — Test `POST /v1/invoices` (création) | 1 h | ⬜ | Workflow complet |

**Acceptance** : 3 endpoints Pennylane répondent correctement via Bearer

#### Story P2.3 — Implémenter skill `aibox-tools` Python
**User story** : Hermes utilise Pennylane (et autres) via un skill Python qui call les microservices.
**Effort** : 2 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending
**Dépendances** : P2.2 (microservice OK)

| Task | Effort | État |
|---|---|---|
| P2.3.1 — Créer `aibox-host/skills/aibox-tools/tool.py` avec httpx + Bearer auth | 4 h | ⬜ |
| P2.3.2 — Fonction `pennylane_list_invoices(status, ctx)` | 2 h | ⬜ |
| P2.3.3 — Fonction `pennylane_create_invoice(client_id, amount, lines, ctx)` | 2 h | ⬜ |
| P2.3.4 — Tester via `hermes chat -z "Liste mes factures impayées"` | 2 h | ⬜ |
| P2.3.5 — Documenter dans SKILL.md les triggers et examples | 1 h | ⬜ |
| P2.3.6 — Tester multi-tool : "crée une facture de X € pour Y" → call create | 2 h | ⬜ |
| P2.3.7 — Commit + push | 30 min | ⬜ |

**Acceptance** : Hermes peut answer "liste mes factures impayées" et "crée une facture" via Pennylane

#### Story P2.4 — Approval gate Telegram pour tools mutatifs
**User story** : Avant tout tool mutatif (créer facture, envoyer mail…), Hermes demande confirmation Telegram à l'employé.
**Effort** : 1.5 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending
**Dépendances** : P2.1 (Telegram OK), P2.3 (skill OK)

| Task | Effort | État |
|---|---|---|
| P2.4.1 — Design pattern : decorator @requires_approval | 1 h | ⬜ |
| P2.4.2 — Implémenter envoi message Telegram avec OK/NON | 2 h | ⬜ |
| P2.4.3 — Implémenter wait response avec timeout 5min | 2 h | ⬜ |
| P2.4.4 — Implémenter audit log dans /opt/aibox/hermes/data/audit.jsonl | 1 h | ⬜ |
| P2.4.5 — Tester : créer facture, attendre Telegram, répondre OK, vérifier exec | 1 h | ⬜ |
| P2.4.6 — Tester : créer facture, attendre Telegram, répondre NON, vérifier abandon | 30 min | ⬜ |
| P2.4.7 — Tester timeout 5min sans réponse → annulation auto | 1 h | ⬜ |

**Acceptance** : 3 scénarios E2E validés (OK / NON / timeout)

#### Story P2.5 — Test Odoo connector
**Effort** : 1 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending
Tasks similaires à P2.2 + P2.3 pour Odoo (partners, sale_orders, invoices).

#### Story P2.6 — Test GLPI connector
**Effort** : 1 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending
Tasks similaires pour tickets list + create.

#### Story P2.7 — Test FEC connector
**Effort** : 1 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending
Tasks pour upload + parsing comptable.

#### Story P2.8 — 3CX téléphonie
**Effort** : 2 j | **Priorité** : 🟢 P2 | **État** : ⬜ pending
Optionnel, complexe SIP. Reporter si pression temps.

#### Story P2.9 — Templates Dify métier
**User story** : Comme client TPE, je trouve 3 assistants pré-configurés (compta, support, commercial) qui marchent out-of-the-box.
**Effort** : 1 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending

---

### 📱 EPIC P3 — Multi-canal mobilité (Sprint 4-5)

#### Story P3.1 — Telegram déjà couvert dans P2.1
*(Move from P2)*

#### Story P3.2 — UI multi-user Telegram dans aibox-app
**User story** : Comme admin, j'ajoute un employé Telegram depuis l'UI aibox-app sans toucher au .env.
**Effort** : 1.5 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending

| Task | Effort | État |
|---|---|---|
| P3.2.1 — Page /admin/employees/telegram avec liste chat_id ↔ user Authentik | 4 h | ⬜ |
| P3.2.2 — Bouton "Ajouter" → form chat_id + sélecteur user Authentik | 2 h | ⬜ |
| P3.2.3 — Endpoint POST /api/admin/telegram/users | 3 h | ⬜ |
| P3.2.4 — Sync vers Hermes (.env TELEGRAM_ALLOWED_USERS) | 2 h | ⬜ |
| P3.2.5 — Audit log dans aibox-app | 1 h | ⬜ |

#### Story P3.3 — Hermes context multi-user
**User story** : Hermes sait quel employé parle et adapte sa réponse (rôle, permissions).
**Effort** : 1 j | **Priorité** : 🔴 P0 | **État** : ⬜ pending

#### Story P3.4 — Email IMAP/SMTP
**Effort** : 2 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending

#### Story P3.5 — WhatsApp Business
**Effort** : 3 j + démarches Meta | **Priorité** : 🟢 P2 | **État** : ⬜ pending

#### Story P3.6 — Notifications proactives
**Effort** : 1.5 j | **Priorité** : 🟠 P1 | **État** : ⬜ pending

---

### 🎨 EPIC P4 — UX et confort (Sprint 6-7)

#### Story P4.1 — Branding FR Hermes
**Effort** : 2 j | **Priorité** : 🔴 P0

| Task | Effort |
|---|---|
| P4.1.1 — Forker SOUL.md avec persona AI Box française | 4 h |
| P4.1.2 — Patcher les prompts système anglais dans /opt/hermes/.../prompts.py | 6 h |
| P4.1.3 — Traduire les error messages user-facing | 3 h |
| P4.1.4 — Tester via Telegram + web : tout est en français | 3 h |

#### Story P4.2 — Onboarding wizard
**Effort** : 2 j | **Priorité** : 🔴 P0

#### Story P4.3 — Mot de passe self-choisi
**Effort** : 0.5 j | **Priorité** : 🔴 P0

#### Story P4.4 — Mémoire conversation cross-channel
**Effort** : 1.5 j | **Priorité** : 🔴 P0

#### Story P4.5 — PWA mobile
**Effort** : 2 j | **Priorité** : 🟠 P1

#### Story P4.6 — Voice (Whisper STT + Piper TTS)
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P4.7 — Auto-suggest prompts
**Effort** : 1 j | **Priorité** : 🟠 P1

---

### 🛠️ EPIC P5 — Ops et fiabilité (Sprint 8-9)

#### Story P5.1 — Backup automatique chiffré
**Effort** : 1.5 j | **Priorité** : 🔴 P0

| Task | Effort |
|---|---|
| P5.1.1 — Cron quotidien 3h matin lance `aibox-host/backup.sh` | 30 min |
| P5.1.2 — Chiffrement age/gpg avec clé custodial (stockée hors site) | 3 h |
| P5.1.3 — Upload vers Backblaze B2 ou OVH Object Storage (config compte) | 3 h |
| P5.1.4 — Rotation : 7 daily + 4 weekly + 12 monthly | 1 h |
| P5.1.5 — Test restore depuis backup encrypted | 3 h |
| P5.1.6 — Healthcheck backup : alert si backup KO 2 jours | 1 h |

#### Story P5.2 — Self-update watcher
**Effort** : 1 j | **Priorité** : 🔴 P0
(`tools/update-watcher.sh` partiellement existe, à finaliser)

#### Story P5.3 — Monitoring alertes
**Effort** : 1 j | **Priorité** : 🔴 P0

#### Story P5.4 — Healthcheck deep + auto-restart
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P5.5 — Logs Loki + Promtail fix
**Effort** : 0.5 j | **Priorité** : 🟠 P1
(Bug connu : promtail ne peut pas joindre docker.sock — déjà identifié)

#### Story P5.6 — Audit RGPD
**Effort** : 2 j | **Priorité** : 🟠 P1

#### Story P5.7 — Documentation ops runbook
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P5.8 — TLS LAN cert auto-signé
**Effort** : 0.5 j | **Priorité** : 🟢 P2

---

### 🚢 EPIC P6 — Reproductible franchise (Sprint 10-12)

#### Story P6.1 — USER-GUIDE.md → PDF + vidéo 5 min
**Effort** : 2 j | **Priorité** : 🔴 P0

#### Story P6.2 — Hardware kit standard
**Effort** : 1 sem recherche (par Andre) | **Priorité** : 🔴 P0

#### Story P6.3 — Image disque pré-installée
**Effort** : 2 j | **Priorité** : 🔴 P0

#### Story P6.4 — provision-new-client.sh
**Effort** : 1.5 j | **Priorité** : 🔴 P0

#### Story P6.5 — Onboarding commercial checklist
**Effort** : 1 j | **Priorité** : 🔴 P0

#### Story P6.6 — Support N1 ticketing
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P6.7 — Calculateur ROI client
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P6.8 — Contrat NDA / RGPD / SLA
**Effort** : externalisé légal | **Priorité** : 🟠 P1

---

### 📈 EPIC P7 — Apprentissage continu (continu)

#### Story P7.1 — Analytics Langfuse
**Effort** : 1 j | **Priorité** : 🔴 P0

#### Story P7.2 — A/B testing prompts
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P7.3 — Curator Hermes activé
**Effort** : 0.5 j | **Priorité** : 🟠 P1

#### Story P7.4 — Optim VRAM (Q3 quant ou modèle plus petit)
**Effort** : 1 j | **Priorité** : 🟠 P1

#### Story P7.5 — Federated learning (skills partagés)
**Effort** : 5 j | **Priorité** : 🟢 P2

---

## 5. Risk Register

| ID | Risque | Impact | Probabilité | Mitigation | Owner |
|---|---|---|---|---|---|
| **R-01** | Latence locale 30s reste un dealbreaker même avec quant | 🔴 Critique | Haute | Cloud LLM hybride obligatoire (P1.1) | Claude |
| **R-02** | GPU 12 Go insuffisant pour qwen3:14b en prod | 🟠 Important | Moyenne | Recommander RTX 4060 Ti 16 Go ou cloud-first | Andre |
| **R-03** | Pennylane / Odoo / GLPI changent leur API | 🟠 Important | Moyenne | Maintenance microservices = poste budget récurrent | Andre |
| **R-04** | WhatsApp Business validation Meta longue (3-10 jours-sem) | 🟢 Mineur | Haute | Telegram + Email en MVP, WhatsApp en phase 3 | Andre |
| **R-05** | Support N1 absent → commercial devient SAV technique | 🟠 Important | Haute | Investir dans doc + self-healing (P5) + GLPI interne (P6.6) | Andre |
| **R-06** | RGPD : registre traitements obligatoire | 🟠 Important | Haute | Documenter dans P5.6, légal externalisé | Andre |
| **R-07** | Hardware initial 1500€/PC plombe la marge sur 1-2 ans | 🟠 Important | Moyenne | Engagement 24-36 mois client + amortissement comptable | Andre |
| **R-08** | Hermes upstream casse compat (image officielle évolue) | 🟠 Important | Faible-Moyenne | Pin version image dans Dockerfile (au lieu de :latest) | Claude |
| **R-09** | Concurrence type Mistral Le Chat Enterprise / Anthropic Hosted | 🟢 Mineur | Haute | Différenciation = on-premise + connecteurs FR | Andre |
| **R-10** | Pilote client refuse de tester (UX trop tech) | 🔴 Critique | Moyenne | P4 (UX) prioritaire, recruter pilote bienveillant | Andre |

---

## 6. Decision Log (ADR-lite)

| ID | Date | Décision | Contexte | Alternative rejetée | Auteur |
|---|---|---|---|---|---|
| ADR-001 | 2026-05-13 | **1 PC dédié par entreprise** (mono-tenant cross-entreprise) | Multi-tenant cloud = trop de complexité + perte souveraineté | Cloud SaaS multi-tenant | Andre |
| ADR-002 | 2026-05-13 | **Multi-user intra-entreprise** (~2-10 employés via Authentik + Telegram) | TPE/PME ont rarement 1 seul user | Mono-user | Andre |
| ADR-003 | 2026-05-13 | **Hermes Agent en concierge unique** | UX messagerie d'abord, web en backup | aibox-app central + Hermes outil | Andre |
| ADR-004 | 2026-05-13 | **Tout BoxIA conservé** (Authentik + Dify + n8n + aibox-app) | Travail métier déjà fait, Hermes en plus | Rip Authentik + Dify | Andre |
| ADR-005 | 2026-05-13 | **Provider LLM hybride** : Anthropic Haiku cloud + qwen3:14b-64k fallback local | Latence local 30s inacceptable + souveraineté possible offline | 100% local OU 100% cloud | Claude+Andre |
| ADR-006 | 2026-05-13 | **Pas de Cloudflare Tunnel par défaut** (LAN-only par défaut) | TLS exposition WAN = optionnel, complique l'install | WAN-first | Andre |
| ADR-007 | 2026-05-13 | **Backup chiffré externe** (Backblaze B2 / OVH Object Storage) | Local-only = perte si vol PC | Local seul | Claude |
| ADR-008 | 2026-05-13 | **Sprint = 2 semaines, plan dans PROJECT-BOARD.md** | Cross-session sans perte de contexte | Issues GitHub | Claude |

---

## 7. KPIs & Definition of Done

### KPIs Produit (mesurables)

| KPI | Cible | Mesure |
|---|---|---|
| **Latence chat p95** | < 5s | Langfuse traces |
| **Disponibilité** | > 99% mensuel | Uptime-Kuma ou Prometheus |
| **NPS pilote** | ≥ 7/10 | Sondage mensuel |
| **Adoption** | > 10 chats/jour/client après 1 mois | Langfuse |
| **Taux résolution autonome** | > 70% (réponses utiles sans escalade humaine) | Feedback +/- sur chats |
| **Time-to-first-value** | < 1h depuis livraison PC | Onboarding checklist |
| **Conso cloud LLM** | < 0.50 €/jour/client en usage normal | Langfuse + facturation Anthropic |

### Definition of Done (DoD) par feature

Une feature est **Done** quand :
1. Code committé sur la branche
2. Test automatique (unit ou intégration) passe — si applicable
3. Test E2E manuel décrit dans la PR
4. Doc utilisateur mise à jour (USER-GUIDE.md ou README selon scope)
5. Doc technique mise à jour si changement archi
6. Pas de régression sur les flows existants (smoke test)
7. PROJECT-BOARD.md mis à jour : status, decision log si applicable

### Definition of Ready (DoR) avant d'attaquer une story

Une story est **Ready** quand :
1. User story claire (qui, quoi, pourquoi)
2. Acceptance criteria écrits et mesurables
3. Tasks atomiques (< 0.5j chacune)
4. Dépendances identifiées et résolues OU listées comme bloqueurs
5. Effort estimé
6. Priorité assignée (P0/P1/P2)

---

## 8. Glossaire

| Terme | Définition |
|---|---|
| **AI Box** | Le produit complet livré chez le client |
| **BoxIA** | Le stack technique (aibox-app + Dify + n8n + Authentik + ...) |
| **Hermes** | L'agent IA concierge basé sur Hermes Agent de Nous Research |
| **Tenant** | Une entreprise cliente (1 PC = 1 tenant) |
| **User / Employé** | Un employé d'un tenant (~2-10 par tenant) |
| **Microservice connecteur** | Service Python FastAPI qui expose un outil métier (Pennylane, Odoo, …) |
| **WBS** | Work Breakdown Structure — hiérarchie des tâches |
| **ADR** | Architecture Decision Record |
| **DoD / DoR** | Definition of Done / Ready |
| **NPS** | Net Promoter Score |

---

## 9. Comment utiliser ce board

### En début de session Claude

1. **Lire ce board** : section "Sprint courant" + "Decision Log" récents
2. **Lire mémoire user** `hermes_deployment_2026-05-13.md` pour le contexte
3. **Choisir 1 tâche** dans le sprint courant (état 🟦 ready)
4. **Mettre en 🚧 in_progress** dans ce fichier + dans TodoWrite session

### Pendant l'exécution

5. **Découper en sous-tâches** via TodoWrite si la tâche est complexe
6. **Logger les décisions** dans Decision Log au fur et à mesure
7. **Logger les risques nouveaux** dans Risk Register
8. **Commit atomique** par sous-task significative

### En fin de session

9. **Mettre à jour le board** : tâches en ✅ done, partielles laissées en 🚧
10. **Commit** : `proj(board): <résumé changement>`
11. **Mémoire user** : ajouter une note brève si découverte importante
12. **Push** : `git push origin HEAD:main` (ou demander à l'user)

### En fin de sprint (toutes les 2 sem)

13. **Retro** : ce qui a marché / pas marché
14. **Demo** : montrer ce qui est livré au sponsor (Andre)
15. **Plan Sprint suivant** : pic 5-10 j-h dans backlog
16. **Update KPIs**

---

📌 **Ce document est vivant**. Mettre à jour à chaque session. Pas de PR review formelle pour le moment, juste un commit avec un message explicite.
