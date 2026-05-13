# AI Box — Guide d'usage client final

> Tu accèdes à ton AI Box pour la première fois ? Voici tout ce qu'il faut savoir.

## 🔐 Tes accès (URLs)

**Important** : Tous les services tournent sur le PC dédié à ton entreprise (192.168.15.210 sur le LAN de test). Remplace par l'IP/nom de ton serveur.

| Service | URL | Pour quoi faire |
|---|---|---|
| **AI Box** (UI principale) | http://192.168.15.210:3100 | Chat, agents, connecteurs métier — c'est là que tu vis |
| **Authentik** | http://192.168.15.210:9000 | Gestion des comptes employés, mots de passe, groupes |
| **Hermes Agent** | http://192.168.15.210:9119 | UI native du concierge IA (sessions, skills, cron, mémoire) |
| **n8n** | http://192.168.15.210:5678 | Workflows automatisés visuels |
| **Dify** | http://192.168.15.210:8081 | Éditeur d'agents IA avancé (text2sql, RAG, etc.) |

## 👤 Comptes (test)

| User | Login | Mot de passe | Rôle |
|---|---|---|---|
| Admin | `akadmin` | `AiBoxTest2026Changeme!` | Full admin (Authentik + AI Box + Dify) |
| Employée | `marie` | `Employe2026!` | User standard (à tester après affectation aux groupes) |

⚠️ **Change ces mots de passe en prod !** Via Authentik http://192.168.15.210:9000 → Users.

## 🚀 Premier login (5 minutes)

1. Ouvre **http://192.168.15.210:3100** dans Chrome / Firefox / Edge
2. Click "Se connecter"
3. Tu es redirigé vers Authentik → entre `akadmin`, puis le mot de passe
4. Tu arrives sur le dashboard AI Box

## 💬 Premier chat (test rapide)

Sur le dashboard AI Box → onglet **Discuter** :
- L'Assistant général est sélectionné par défaut (modèle local `qwen3:14b-64k`)
- Tape une question : "Bonjour, qui es-tu ?"
- La réponse prend **15-40 secondes** (modèle local sur GPU 12 Go — limite VRAM)
- Pour aller plus vite : passe en cloud LLM (Anthropic Claude Haiku) dans Paramètres → Cloud Providers

## 👥 Ajouter un employé

1. Authentik → http://192.168.15.210:9000
2. Login `akadmin` / mot de passe
3. **Admin interface** (top right) → **Directory → Users → Create**
4. Username + email + nom + group "AI Box Users"
5. **Set password** dans le user créé
6. Donne le login à l'employé. Il pourra se connecter via http://192.168.15.210:3100

## 🤖 Hermes Agent (concierge multi-canal)

Hermes tourne en parallèle d'AI Box. Pour l'instant :
- **Dashboard web** http://192.168.15.210:9119 — UI native, peux discuter directement
- **API** http://aibox-hermes:8642 — utilisable depuis n8n ou scripts (Bearer auth)

### Activer Telegram (à faire toi-même)

1. Sur Telegram, parle à **@BotFather** → `/newbot` → noter le token
2. Sur xefia (SSH) :
   ```
   sudo bash -c 'echo "TELEGRAM_BOT_TOKEN=<token>" >> /opt/aibox/hermes/.env'
   sudo bash -c 'echo "TELEGRAM_ALLOWED_USERS=<ton_chat_id>" >> /opt/aibox/hermes/.env'
   sudo docker compose -f /opt/aibox/hermes/docker-compose.hermes.yml restart
   ```
3. Envoie un message à ton bot Telegram, Hermes répond

Pour obtenir ton chat_id : `/start` au bot puis `curl https://api.telegram.org/bot<TOKEN>/getUpdates`

## 🔌 Connecteurs métier

Depuis AI Box → sidebar **Connecteurs** ou **Marketplace IA** :
- Pennylane (compta) — clé API à fournir
- Odoo (ERP) — URL + clé API
- GLPI (helpdesk) — URL + tokens
- FEC import (compta universel)
- 3CX (téléphonie)

Une fois activé, les agents (général/vision/dédié) peuvent appeler le connecteur. Et Hermes aussi.

## 🛠️ Maintenance

### Diagnostic

```bash
# SSH sur le serveur
ssh clikinfo@192.168.15.210

# État des 33 containers
docker ps

# Logs d'un service
docker logs aibox-hermes -f
docker logs aibox-app --tail 50
docker logs ollama --tail 30

# Santé Hermes (sans curl ext)
docker exec aibox-hermes /opt/hermes/.venv/bin/hermes doctor
```

### Mise à jour

```bash
cd ~/aibox-repo
git pull
sudo bash aibox-host/aibox-install.sh --update
```

### Backup / restore

```bash
# Backup
sudo bash aibox-host/backup.sh
# → /var/backups/aibox-YYYY-MM-DD.tar.gz

# Restore (sur PC neuf après install)
sudo bash aibox-host/restore.sh /chemin/vers/backup.tar.gz
```

## ⚠️ Limitations connues (à l'écrit du 2026-05-13)

1. **Latence ~30s/réponse** en mode local (modèle qwen3:14b sur VRAM 12 Go, débord CPU 33/67). Solution : activer un provider cloud (Anthropic Claude Haiku ~3s).
2. **Migrations Dify** initiales échouées (12 sur 12) car Dify pas encore prêt au moment des migrations. À rejouer : `sudo bash ~/aibox-repo/tools/migrations/run-pending.py`.
3. **NEXTAUTH_URL** par défaut sur `localhost:3100` → patché manuellement sur 192.168.15.210. Pour un PC client, à régénérer avec le nom DNS final.
4. **Admin email = admin@acme-sarl.local** (généré depuis DOMAIN du .env BoxIA, hardcodé "Acme SARL" en mode bootstrap). À customiser via Authentik admin.
5. **Hermes skill `aibox-tools`** : squelette présent mais le code Python concret pour appeler les microservices connecteurs FR reste à implémenter (cf. SKILL.md).

## 🆘 En cas de problème

- Container down : `docker compose -f services/<service>/docker-compose.yml up -d` (à exécuter depuis `/srv/ai-stack`)
- Reset complet (efface tout, garde Docker installé) : `bash ~/aibox-repo/tools/wipe-box.sh clikinfo@<host> --wipe-data --wipe-images --yes`
- Logs serveurs centraux : Grafana http://192.168.15.210:3000 (admin / aibox-changeme2026)

## 📞 Support

- Repo source : https://github.com/Tobaz34/BoxIA
- Doc technique installer : `aibox-host/README.md`
- Architecture décisions : `tools/hermes/ARCHITECTURE.md`
