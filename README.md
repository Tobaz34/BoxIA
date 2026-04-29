# AI Box — Serveur IA local pour TPE/PME

Solution clé-en-main de **serveur IA souverain** déployable chez un client : chat type ChatGPT privé, RAG sur documents internes, automatisations no-code, agents personnalisables.

## 📦 Ce que ça contient

| Brique | Rôle | URL (par défaut) |
|---|---|---|
| **Authentik** | SSO unique + dashboard apps | `https://auth.<DOMAIN>` |
| **Open WebUI** | Chat IA type ChatGPT (utilisateur final) | `https://chat.<DOMAIN>` |
| **Dify** | Agent builder no-code + RAG entreprise | `https://agents.<DOMAIN>` |
| **n8n** | Workflows / automatisations | `https://flows.<DOMAIN>` |
| **Qdrant** | Vector DB (RAG) | interne |
| **Ollama** | Moteur LLM local | interne |
| **Portainer** | Gestion containers (admin) | `https://admin.<DOMAIN>` |
| **Uptime Kuma** | Monitoring services | `https://status.<DOMAIN>` |
| **Duplicati** | Sauvegardes chiffrées | interne admin |
| **Nginx Proxy Manager** | Reverse proxy + TLS | `:8181` (admin) |

## 🖥️ Prérequis matériel

| Profil | RAM | GPU | Disque | Users concurrents |
|---|---|---|---|---|
| **TPE** | 32 Go | RTX 4060 Ti 16Go / 4070 Super 12Go | 1 To NVMe | 1-5 |
| **PME** | 64 Go | RTX 4090 24Go ou A5000 | 2 To NVMe | 5-20 |
| **PME+** | 128 Go | RTX 6000 Ada 48Go ou 2× 4090 | 4 To NVMe RAID | 20-100 |

**OS** : Ubuntu Server 24.04 LTS (recommandé). Docker 24+ et NVIDIA Container Toolkit 1.17+.

## 🚀 Installation chez un nouveau client

```bash
# 1. Cloner ce repo sur le serveur
git clone <URL_REPO> /srv/aibox && cd /srv/aibox

# 2. Lancer l'installeur interactif
./install.sh

# 3. Suivre les questions :
#    - Nom du client
#    - Domaine principal (ex: ai.monclient.fr)
#    - Email admin
#    - Profil hardware (TPE / PME / PME+)
#    - Modèles à pré-télécharger

# 4. Une fois terminé, ouvrir l'URL affichée → login Authentik (compte admin créé)
```

L'installeur génère un `.env` complet avec tous les secrets aléatoires, configure les sous-domaines NPM, et démarre la stack.

## 🛠️ Commandes utiles

```bash
./update.sh                       # MAJ images + backup auto + restart sans recreate destructif
./backup.sh                       # Snapshot tous les volumes critiques (~30s, ~10 GB)
./backup.sh quick                 # Backup rapide (DB seulement, sans modèles Ollama)
./backup.sh restore <stamp>       # Restore depuis un backup donné
docker compose ps                 # Vue détaillée
docker compose logs -f <service>  # Logs en direct
```

**⚠️ Toujours `./backup.sh` avant toute opération sur les containers.**
Voir [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) pour les procédures sûres et la post-mortem de l'incident du 2026-04-28.

## 🧱 Architecture

```
┌─────────────────────────────────────────────────┐
│ Utilisateur → https://ai.monclient.fr           │
│         (1 seule URL d'entrée)                  │
└────────────────┬────────────────────────────────┘
                 │
        ┌────────▼─────────┐
        │ NPM (TLS + auth) │
        └────────┬─────────┘
                 │
        ┌────────▼─────────┐
        │ AUTHENTIK (SSO)  │  ← un seul login pour tout
        │ + App Launcher   │  ← l'utilisateur voit ses apps autorisées
        └────────┬─────────┘
                 │
   ┌─────────────┼──────────────────────┐
   ▼             ▼                      ▼
┌───────┐   ┌────────┐             ┌─────────┐
│ Chat  │   │ Agents │             │  n8n    │
│(OWUI) │   │ (Dify) │             │workflows│
└───┬───┘   └───┬────┘             └─────────┘
    │           │
    └─────┬─────┘
          ▼
     ┌─────────┐         ┌─────────┐
     │ Qdrant  │         │ Ollama  │
     │(vectors)│         │  (GPU)  │
     └─────────┘         └─────────┘
```

## 📝 Documentation

- [`ROADMAP.md`](./ROADMAP.md) — Vision produit (POC → portail → industrialisation)
- [`EXECUTION-PLAN.md`](./EXECUTION-PLAN.md) — **Plan de sprints détaillé pour aller jusqu'au produit shippable (10-12 semaines)**
- [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — Procédures sûres, post-mortem incident
- [`docs/QUESTIONNAIRE.md`](./docs/QUESTIONNAIRE.md) — Questionnaire de qualification client
- [`services/connectors/CATALOG.md`](./services/connectors/CATALOG.md) — Catalogue des ~30 connecteurs envisagés

## 🔐 Sécurité de base

- Pas de port exposé en WAN par défaut (tout passe par NPM avec TLS Let's Encrypt)
- Tailscale recommandé pour l'accès admin distant (Zero Trust)
- Authentik en frontal de tout (SSO obligatoire)
- Secrets générés aléatoirement à l'install, jamais commit
- Sauvegardes chiffrées Duplicati (cible : NAS client + offsite cloud)

## 📜 Licence et support

Stack composée de briques open source (chacune sous sa propre licence). Le packaging et les scripts d'install sont propriétaires.
