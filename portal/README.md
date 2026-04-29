# Portail de provisioning AI Box

> Outil interne de l'éditeur (toi). Permet de déployer une AI Box chez un nouveau client via un wizard graphique au lieu d'un `install.sh` CLI.

## Statut

🚧 **Squelette en cours de développement** — la stack POC est livrée fonctionnelle, le portail vient ensuite.

## Vision

Le portail est ce que **toi** utilises lors d'un RDV commercial / d'une installation chez un nouveau client. Il :

1. **Affiche le questionnaire** des 56 éléments de qualification (cf. `../config/questionnaire.yaml`)
2. **Génère le `client_config.yaml`** + `.env` depuis les réponses
3. **Pousse via SSH** sur le serveur cible et lance `install.sh` en mode non-interactif
4. **Suit le déploiement** (logs streamés en temps réel)
5. **Affiche les credentials générés** + URL d'accès à donner au client

À terme, devient ton **back-office multi-clients** : suivi de tous les serveurs déployés, métriques d'usage, mises à jour pilotées centralement.

## Architecture cible

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend Next.js 15 (App Router) + shadcn/ui + Tailwind     │
│  - /                   → liste des clients                   │
│  - /new                → wizard de qualification (5 étapes)  │
│  - /clients/[id]       → fiche client + état du serveur      │
│  - /clients/[id]/deploy → suivi déploiement live             │
└──────────────────────────┬───────────────────────────────────┘
                           │ REST + WebSocket (logs)
┌──────────────────────────▼───────────────────────────────────┐
│  Backend FastAPI (Python 3.12)                              │
│  - /api/clients         CRUD                                 │
│  - /api/questionnaire   structure (lit questionnaire.yaml)   │
│  - /api/deploy          POST → lance déploiement async       │
│  - /api/deploy/{id}/ws  WebSocket → stream logs              │
│  - /api/templates       templates n8n / Dify dispo           │
└──────────────────────────┬───────────────────────────────────┘
                           │ Paramiko SSH + Docker SDK
┌──────────────────────────▼───────────────────────────────────┐
│  Serveurs clients (1..N)                                     │
│  - install.sh exécuté à distance                             │
│  - Pull du repo AI Box (git clone)                           │
│  - docker compose up                                         │
└──────────────────────────────────────────────────────────────┘
```

## Données

- **SQLite** local : `portal.db` (clients, déploiements, logs)
- **Pas de cloud** : le portail tourne en local chez l'éditeur (toi)
- **Auth** : un seul compte admin (toi) avec WebAuthn (clé physique)

## Flow utilisateur cible (wizard)

### Étape 1 — Identité client
- Nom entreprise, secteur, taille (10-100 users), logo, couleurs

### Étape 2 — Cible technique
- IP / domaine du serveur
- Profil hardware détecté (auto via SSH probe : CPU/RAM/GPU)
- Crédentiels SSH

### Étape 3 — Questionnaire 11 chapitres
- Navigation latérale chapitre par chapitre
- Pastille verte sur briques enrichissables IA
- Description de l'apport IA pour chaque
- Champ "précision" libre

### Étape 4 — Cas d'usage prioritaires
- Cocher 3-5 use cases parmi liste sectorielle
- Le portail propose les templates Dify + workflows n8n correspondants

### Étape 5 — Récapitulatif & déploiement
- Aperçu de ce qui sera installé
- Estimation temps déploiement
- "Déployer maintenant" → SSH + logs live
- À la fin : URL + credentials à transmettre au client

## Squelette présent dans ce dossier

- `backend/` : skeleton FastAPI (à enrichir)
- `frontend/` : à initialiser avec `npx create-next-app@latest`
- `README.md` : ce fichier

## Démarrage du squelette backend (dev)

```bash
cd portal/backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
# Accès : http://localhost:8000/docs (Swagger auto)
```

## Roadmap dev

- [ ] **v0.1** : squelette FastAPI + endpoint `/api/questionnaire` qui sert le YAML
- [ ] **v0.2** : modèle Client en SQLite + CRUD basique
- [ ] **v0.3** : génération `client_config.yaml` depuis JSON wizard
- [ ] **v0.4** : déploiement via SSH (Paramiko) avec logs WebSocket
- [ ] **v0.5** : front Next.js wizard 5 étapes
- [ ] **v1.0** : prod avec WebAuthn + branding client

## Estimation

~3-4 semaines à temps plein pour la v1.0 utilisable en RDV commercial.
