# Installation AI Box

## ⚡ En 1 commande (recommandé)

Sur un Ubuntu 22.04 ou 24.04 fraîchement installé, exécute :

```bash
curl -fsSL https://raw.githubusercontent.com/Tobaz34/BoxIA/main/bootstrap.sh | sudo bash
```

C'est tout. Le script installe Docker, NVIDIA toolkit (si GPU), clone le repo, lance le wizard.

Quand il a fini (~5 min), ouvre depuis **n'importe quel poste sur le LAN** (Windows, Mac, iPhone) :

👉 **http://aibox.local**

Le wizard te demande 5 infos en 5 minutes (entreprise, admin, technos), puis déploie tout en arrière-plan (10-15 min — pull des images Docker + des modèles Ollama si premier coup).

---

## Prérequis matériel

| | Min (TPE, 1-5 users) | Recommandé (PME, 5-20 users) |
|---|---|---|
| **OS** | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| **CPU** | x86_64 4 cores | 8+ cores |
| **RAM** | 32 GB | 64 GB |
| **GPU** | NVIDIA 12 GB VRAM | NVIDIA 24 GB+ VRAM |
| **Disque** | 200 GB SSD | 500 GB NVMe |
| **Réseau** | LAN + Internet (pour le pull initial) | |

Pas obligé d'avoir un GPU — le bootstrap le détecte automatiquement et bascule en CPU-only (les modèles tourneront, juste plus lentement).

---

## Que fait `bootstrap.sh` exactement ?

1. **Outils de base** — `git`, `curl`, `ca-certificates`, `gnupg`, `lsb-release`
2. **Docker Engine** — via le script officiel `get.docker.com` (skip si déjà installé)
3. **NVIDIA Container Toolkit** — uniquement si GPU NVIDIA détectée (skip sinon)
4. **Clone du repo** — `https://github.com/Tobaz34/BoxIA.git` dans `/srv/ai-stack`
5. **`install-firstrun.sh`** :
   - Hostname → `aibox`
   - Avahi → annonce `aibox.local` sur le LAN
   - Aliases mDNS plats → `aibox-auth.local`, `aibox-chat.local`, `aibox-agents.local`, etc.
   - Service systemd `aibox-firstrun.service` qui démarre le wizard sur `:80`

Le script est **idempotent** : tu peux le re-lancer sans casse, il saute ce qui est déjà fait.

---

## Wizard (5 étapes)

Une fois `http://aibox.local` ouvert :

1. **Identité entreprise** — nom, secteur, taille
2. **Domaine + admin** — choix du mot de passe (jamais loggé)
   - Pour LAN : laisse `aibox.local` (default)
   - Pour prod publique : ton vrai domaine (ex: `ai.client.fr`)
3. **Technologies** — coche celles utilisées (M365, Sage, Odoo, Salesforce, etc.) → active les connecteurs RAG correspondants
4. **Récap** — vérification des choix
5. **Déploiement** — clique « Lancer », logs en live ; **10-15 min** (premier déploiement) :
   - Pull des images Docker (Authentik, Dify, Postgres, Redis, Qdrant, Caddy, etc.)
   - Pull des modèles Ollama (qwen2.5, qwen2.5vl, bge-m3, llama-guard) — **+30 min** la 1<sup>re</sup> fois
   - Création du compte admin Authentik avec ton mot de passe
   - Provisioning OIDC (apps + agents Dify)
   - Build de l'app Next.js

À la fin → l'app principale est sur **`https://aibox.local`** *(certificat auto-signé en LAN, accepter l'avertissement Chrome/Firefox)*.

---

## Vérification post-install

```bash
# Tous les containers up ?
docker ps --format "table {{.Names}}\t{{.Status}}" | grep aibox

# Le mDNS répond ?
avahi-resolve -n4 aibox-auth.local

# La box est marquée configurée ?
ls /var/lib/aibox/.configured
```

Tu devrais voir une douzaine de containers `aibox-*` (Authentik, Dify, Caddy, app, Qdrant, etc.) tous en `Up`.

---

## Problèmes courants

### `aibox.local` ne résout pas depuis Windows

- Bonjour est requis. Apple iTunes l'installe automatiquement, sinon : [https://support.apple.com/downloads/bonjour](https://support.apple.com/downloads/bonjour).
- Fallback : utilise l'IP du serveur (`http://192.168.x.y`).

### Le pull des modèles Ollama est lent

Normal — la première fois c'est ~10 GB à télécharger. Tu peux pré-pull manuellement avant le wizard :

```bash
docker exec ollama ollama pull qwen2.5:7b
docker exec ollama ollama pull qwen2.5vl:7b
docker exec ollama ollama pull bge-m3
```

### Refaire le wizard (re-tester)

```bash
cd /srv/ai-stack
./reset-as-client.sh        # garde modèles + code, rejoue juste le wizard
```

### Reset complet (simulation serveur neuf)

```bash
cd /srv/ai-stack
./wipe-and-reinstall.sh     # rase tout sauf modèles Ollama, re-clone, re-firstrun
```

---

## Installation manuelle (sans bootstrap)

Si tu préfères contrôler chaque étape, voir [`docs/INSTALL-MANUAL.md`](docs/INSTALL-MANUAL.md) (à venir) ou suis ce qu'fait `bootstrap.sh` à la main :

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2. NVIDIA toolkit (si GPU)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 3. Clone + firstrun
sudo git clone https://github.com/Tobaz34/BoxIA.git /srv/ai-stack
sudo chown -R $USER:$USER /srv/ai-stack
sudo bash /srv/ai-stack/services/setup/install-firstrun.sh
```
