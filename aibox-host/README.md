# AI Box — Installation client (PC dédié 1 entreprise)

> Installer one-command pour déployer une AI Box complète sur un PC dédié à une entreprise (TPE/PME). Hermes Agent en concierge multi-utilisateur, accessible via Telegram + WhatsApp + Email + web admin.

## Pour qui

- **1 PC dédié** = **1 entreprise** (mono-tenant)
- **N employés** dans l'entreprise (~2-10), chacun avec son chat Telegram et son compte web
- **Configuration en 1 commande**, mise à jour à distance, backup automatisable

## Pré-requis matériel minimal

| Élément | Minimum | Recommandé |
|---|---|---|
| CPU | 4 cores | 8+ cores (Intel i7/i9, AMD Ryzen 7+) |
| RAM | 16 Go | 32 Go |
| Disque | 60 Go libres | 200 Go SSD |
| GPU | aucun (mode cloud) | NVIDIA 8+ Go VRAM (mode local) |
| OS | Ubuntu 22.04 | Ubuntu 24.04 LTS |
| Réseau | LAN Ethernet 100 Mbit/s | Gigabit + IP fixe |

## Installation (1 commande, ~25 minutes sur PC vierge)

```bash
# 1. Cloner le repo (clé GitHub ou HTTPS public)
git clone https://github.com/Tobaz34/BoxIA.git /opt/aibox-repo
cd /opt/aibox-repo

# 2. Lancer l'installer en root
sudo aibox-host/aibox-install.sh
```

Le script :
1. Vérifie OS + RAM + disque + GPU
2. Installe Docker + NVIDIA Container Toolkit (si GPU)
3. Déploie le stack BoxIA (Authentik, Dify, n8n, Postgres, Ollama, aibox-app, connecteurs)
4. Lance le **wizard** : nom entreprise, clé cloud LLM, bot Telegram, connecteurs
5. Build l'image Hermes custom (`aibox-hermes:fr`), démarre Hermes
6. Configure le provider LLM (cloud primary + fallback local qwen3:14b-64k)
7. Installe les skills AI Box dans Hermes
8. Test E2E

## Premier usage

À la fin de l'install, le script affiche :

```
✓ AI Box installée

  Entreprise          : Boulangerie Martin (slug: boulangerie-martin)
  Provider LLM        : anthropic
  Telegram            : configuré (chat_ids: 123456789)
  Dashboard Hermes    : http://192.168.1.100:9119
  Admin web aibox-app : http://192.168.1.100:3100
```

- **Côté employé** : ouvre Telegram, parle au bot. Hermes répond.
- **Côté admin** : navigateur sur `http://192.168.1.100:3100`, login Authentik (compte créé via wizard).

## Mise à jour (à distance)

```bash
sudo aibox-host/aibox-install.sh --update
```

Le script :
1. `git pull` du repo
2. Rebuild les images Docker modifiées
3. Recreate les containers concernés
4. Préserve toutes les données (`.env`, volumes)
5. Test E2E final

## Modes du script

| Mode | Commande | Quand |
|---|---|---|
| Install complet | `sudo aibox-install.sh` | PC vierge, déploiement initial |
| Hermes only | `sudo aibox-install.sh --hermes-only` | Stack BoxIA déjà installée, ajout/ré-install Hermes |
| Update | `sudo aibox-install.sh --update` | PC déjà installé, nouvelle version dispo |
| Dry-run | `sudo aibox-install.sh --check` | Vérifier pré-requis sans rien installer |

## Fichiers de ce dossier

```
aibox-host/
├── aibox-install.sh                       # ⭐ Installer one-command
├── wizard.sh                        # Wizard interactif (relançable)
├── Dockerfile                       # Image hermes:fr (Hermes + python-telegram-bot)
├── docker-compose.hermes.yml        # Service Hermes (joint aibox_net)
├── lib/
│   ├── prereqs.sh                   # Vérifs OS/RAM/disque/GPU
│   ├── docker-setup.sh              # Install Docker + NVIDIA Toolkit
│   └── hermes-config.sh             # Config provider + fallback + skills
├── skills/
│   └── aibox-tools/                 # Skill Hermes → microservices connecteurs FR
│       └── SKILL.md
└── README.md                        # Ce fichier
```

## Architecture

```
                  Employés Telegram (chat_id A, B, C...)
                              │
                              ▼
                  ┌───────────────────────┐
                  │   Hermes Agent         │  ← concierge unique multi-user
                  │   aibox-hermes:fr      │     - RBAC par user
                  │   skills aibox-tools   │     - audit per chat_id
                  └──────────┬─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
   Ollama (LLM local)  Microservices  Dify agents
   qwen3:14b-64k       connecteurs FR (text2sql,
   + fallback cloud    (Pennylane,    RAG, etc.)
   (Claude Haiku /     Odoo, GLPI,
   Gemini Flash)       FEC, 3CX)
                              │
                              ▼
                       n8n workflows
                       (auto, planifiés,
                       marketplace)
                              │
                              ▼
                  Postgres + Authentik + aibox-app (admin)
```

## Backup / restore (à venir)

```bash
sudo aibox-host/backup.sh                       # → /var/backups/aibox-YYYY-MM-DD.tar.gz
sudo aibox-host/restore.sh /path/to/backup.tar.gz
```

## Diagnostic

```bash
# Tous les containers up ?
docker ps

# Logs Hermes
docker logs aibox-hermes -f

# Statut Hermes
docker exec aibox-hermes /opt/hermes/.venv/bin/hermes doctor

# Test API
HERMES_KEY=$(grep API_SERVER_KEY /opt/aibox/hermes/.env | cut -d= -f2)
curl -X POST http://localhost:9119/api/v1/chat \
  -H "Authorization: Bearer $HERMES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
```

## Coûts indicatifs (par client, par mois)

- Cloud LLM (Claude Haiku, ~500 messages/jour) : **5-15 €**
- Hardware amorti sur 3 ans (PC ~1500 €) : **~40 €**
- Énergie (PC allumé 24/7, ~50W) : **~5 €**
- Internet (existant) : 0
- **Total** : ~50-60 €/mois en coûts directs

Marge confortable sur un prix franchise 79-149 €/mois.

## Sécurité

- Bot Telegram : authentification par `chat_id` whitelisté (TELEGRAM_ALLOWED_USERS)
- Microservices connecteurs : Bearer auth (AIBOX_AGENT_KEY shared secret, généré au wizard)
- aibox-app : Authentik SSO (1 tenant entreprise, users locaux email/pwd)
- Aucun port WAN exposé par défaut. Pour télétravail employé : reverse proxy + TLS via NGINX Proxy Manager (à configurer).
- Données : tout reste sur le PC dédié. Seules les requêtes LLM cloud sortent (anonymisées si mode hybride + PII scrub).
