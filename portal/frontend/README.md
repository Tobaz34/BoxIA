# Portail AI Box — Frontend (Next.js 15)

Interface admin du **portail externe** de provisioning. Utilisée par l'éditeur (toi) pour déployer/gérer les serveurs AI Box des clients.

## Démarrer en dev

```bash
# 1. Backend FastAPI (terminal 1)
cd portal/backend
python -m venv .venv && source .venv/bin/activate   # ou .venv\Scripts\activate sous Windows
pip install -r requirements.txt
uvicorn main:app --reload                            # http://localhost:8000

# 2. Frontend Next.js (terminal 2)
cd portal/frontend
npm install
npm run dev                                          # http://localhost:3000
```

Le `next.config.mjs` proxifie `/api/*` vers `http://localhost:8000` (variable `AIBOX_BACKEND_URL` pour override).

## Pages

| Route | Rôle |
|---|---|
| `/` | Landing du portail |
| `/clients` | Liste des clients déployés |
| `/clients/new` | Wizard 5 étapes (création + déploiement) |
| `/clients/[id]` | Détail client + logs de déploiement (WebSocket) |

## Stack

- **Next.js 15** (App Router, React 19)
- **Tailwind CSS** (couleurs custom alignées sur le wizard embarqué : `bg`, `panel`, `panel2`, `primary`, `accent`, …)
- **Lucide React** pour les icônes
- Pas de framework UI (shadcn/ui peut être ajouté plus tard si besoin)

## Build prod

```bash
npm run build
npm start                         # serveur Node
# ou export statique si backend séparé :
# next.config.mjs : output: 'export'
```

## Roadmap

- [x] v0.1 : pages liste + wizard + détail (squelette fonctionnel)
- [ ] v0.2 : auth admin (mot de passe + WebAuthn)
- [ ] v0.3 : page de "templates n8n / agents Dify pré-chargés à pousser"
- [ ] v0.4 : mode RDV — wizard utilisable en direct chez le client (saisie collaborative)
- [ ] v0.5 : dashboard multi-clients (état, métriques d'usage, alertes)
- [ ] v1.0 : intégration backups + rollback + maj centralisées
