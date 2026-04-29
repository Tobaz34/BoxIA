# Installation d'AI Box sur un nouveau serveur

> Procédure complète pour déployer une AI Box clean chez un nouveau client (ou sur un nouveau serveur de test).

## 0. Prérequis matériel

| Élément | Minimum (TPE) | Recommandé (PME) |
|---|---|---|
| CPU | 8 cœurs | 16+ cœurs |
| RAM | 32 Go | 64 Go |
| GPU | RTX 4060 Ti 16Go / 4070 Super 12Go | RTX 4090 24 Go |
| Stockage | 1 To NVMe | 2 To NVMe |
| OS | Ubuntu Server **24.04 LTS** (recommandé) | idem |

## 1. Préparation OS (post-install Ubuntu 24.04)

```bash
sudo apt update && sudo apt upgrade -y

# Outils de base
sudo apt install -y git curl ca-certificates gnupg lsb-release

# Docker depuis le repo officiel
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# User dans le groupe docker (pas besoin de sudo pour docker)
sudo usermod -aG docker $USER
newgrp docker  # ou se déconnecter / reconnecter
```

## 2. NVIDIA driver + Container Toolkit (si GPU)

```bash
# Driver NVIDIA (serveur sans X)
sudo apt install -y nvidia-driver-580
sudo reboot

# Container Toolkit (au retour)
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sudo sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Vérification
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

## 3. Cloner AI Box

```bash
sudo mkdir -p /srv/ai-stack
sudo chown $USER:$USER /srv/ai-stack
git clone https://github.com/Tobaz34/BoxIA.git /srv/ai-stack
cd /srv/ai-stack

# Pour figer une version stable :
# git checkout v1.0.0   (tags semver depuis les releases GitHub)
```

## 4. Configurer l'image disque pour le mode "appliance" (optionnel)

Si tu veux livrer la box au client en mode "branche et allume → wizard sur aibox.local" :

```bash
sudo bash /srv/ai-stack/services/setup/install-firstrun.sh
```

Ce script installe :
- `hostnamectl set-hostname aibox`
- Avahi (annonce mDNS `aibox.local`)
- service systemd `aibox-firstrun.service` qui démarre le wizard au boot
- ne se relance plus une fois `/var/lib/aibox/.configured` créé

→ tu clones cette image disque (Clonezilla / `dd`) pour chaque client.

## 5. Premier setup chez le client

### Option A — Wizard graphique (recommandé)
Le client va sur `http://aibox.local` (ou `http://<IP-de-la-box>`) → suit le wizard 5 étapes → ~3 minutes → tout est prêt.

### Option B — CLI interactif (admin avancé)
```bash
cd /srv/ai-stack
./install.sh
```

### Option C — Non-interactif (CI / script)
```bash
# Pré-remplir le .env (voir .env.example pour la liste complète)
cp .env.example .env
$EDITOR .env

# Déployer sans poser de questions
AIBOX_NONINTERACTIVE=1 ./install.sh
```

## 6. Mise à jour quotidienne

### Update simple (depuis la box)
```bash
cd /srv/ai-stack
git pull
./update.sh   # backup auto + docker compose pull + recreate
```

### Update centralisée via le portail externe
Voir [`portal/README.md`](../portal/README.md). Le portail SSH push sur la box et lance `./update.sh`.

### Update auto (cron quotidien)
```bash
# /etc/cron.d/aibox-update
0 4 * * 1 root cd /srv/ai-stack && ./scripts/aibox-updater.sh
```

Ce script vérifie les nouvelles releases sur GitHub et applique automatiquement les versions tagged `vX.Y.Z` selon une politique configurable (voir `scripts/aibox-updater.sh`).

## 7. Sécurité

### Authentification SSH par clé (mot de passe désactivé)
```bash
# Sur ton poste : copier ta clé publique vers la box
ssh-copy-id user@<IP-box>

# Sur la box : désactiver mdp
sudo bash /srv/ai-stack/services/security/harden.sh
```

Le script `harden.sh` configure : UFW, CrowdSec, SSH durci, AppArmor, auditd, unattended-upgrades.

### Sauvegardes offsite
Renseigner dans `.env` au moment du setup :
```
BACKUP_REMOTE_TYPE=b2          # ou wasabi / s3 / sftp
BACKUP_REMOTE_BUCKET=client-aibox-backup
BACKUP_REMOTE_ACCESS_KEY=...
BACKUP_REMOTE_SECRET_KEY=...
BACKUP_ENCRYPTION_PASSPHRASE=...   # généré aléatoirement si vide
```
Duplicati pousse alors les backups chiffrés AES-256 vers le cloud du client (B2 ~5 €/mois pour 100 Go).

## 8. Troubleshooting

### Le wizard ne démarre pas
```bash
sudo systemctl status aibox-firstrun
sudo journalctl -u aibox-firstrun -n 50
```

### Réinitialiser un setup raté
```bash
cd /srv/ai-stack
./reset-as-client.sh    # demande confirmation
# OU pour un reset sans interaction :
./reset-as-client.sh --yes
```

### Voir l'état complet de la stack
```bash
docker ps --filter name=aibox --format 'table {{.Names}}\t{{.Status}}'
```

### Reset sécurisé (conserve les données)
```bash
cd /srv/ai-stack && ./backup.sh    # snapshot avant
./reset-as-client.sh --keep-owui   # garde les chats Open WebUI
```

## 9. Suppression complète

```bash
cd /srv/ai-stack
docker compose down -v             # -v supprime AUSSI les volumes data
( cd services/authentik && docker compose down -v )
( cd services/dify && docker compose down -v )
( cd services/inference && docker compose down -v )
( cd services/edge && docker compose down -v )
( cd services/setup && docker compose down -v )
sudo rm -rf /srv/ai-stack /srv/aibox-backups /var/lib/aibox
```
