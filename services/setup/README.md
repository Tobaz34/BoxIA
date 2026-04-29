# Portail de setup embarqué (first-run)

Le client allume sa box AI Box pour la première fois → va sur **`http://aibox.local`** → wizard de configuration → tout est prêt.

Expérience type **Synology DSM Setup** ou **TrueNAS Wizard**.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  AI Box — Premier démarrage                              │
│                                                          │
│  [systemd] aibox-firstrun.service                        │
│      │                                                   │
│      ├─ ConditionPathExists=!/var/lib/aibox/.configured │
│      │  → ne démarre QUE si pas encore configurée        │
│      │                                                   │
│      ├─ Avahi annonce 'aibox.local' (mDNS/Bonjour)      │
│      │                                                   │
│      └─ docker compose up                                │
│           ├─ aibox-setup-caddy   (port 80 LAN)          │
│           └─ aibox-setup-api     (FastAPI + wizard)     │
│                                                          │
│  Le client va sur http://aibox.local                     │
│      ↓                                                   │
│  Wizard 5 étapes :                                       │
│    1. Identité entreprise (nom, secteur, taille)        │
│    2. Domaine + COMPTE ADMINISTRATEUR (nom, login, mdp) │
│    3. Questionnaire 11 chapitres (techs utilisées)      │
│    4. Récapitulatif                                      │
│    5. Déploiement (logs en live via WebSocket)          │
│                                                          │
│  À la fin :                                              │
│    - Compte admin créé dans Authentik avec mdp choisi   │
│    - /var/lib/aibox/.configured créé                    │
│    - aibox-firstrun.service ne se relancera plus        │
│    - NPM peut prendre :80 / :443 pour le dashboard      │
└──────────────────────────────────────────────────────────┘
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `docker-compose.yml` | Stack du wizard (Caddy + API FastAPI) |
| `Caddyfile` | Reverse proxy interne (Caddy → API) |
| `app/main.py` | Backend FastAPI (endpoints config + déploiement) |
| `app/Dockerfile` | Build du container API |
| `app/templates/wizard.html` | UI du wizard (single-page) |
| `app/templates/configured.html` | Page affichée une fois la box configurée |
| `app/static/wizard.css` | Styles (look sombre, propre) |
| `app/static/wizard.js` | Logique des 5 étapes côté client |
| `aibox-firstrun.service` | Service systemd qui démarre le wizard au boot |
| `aibox.avahi.service` | Annonce `aibox.local` sur le LAN |
| `install-firstrun.sh` | Script d'installation côté hôte |

## Installation côté usine (avant livraison)

Sur l'image disque de référence (à cloner pour chaque client) :

```bash
cd /srv/ai-stack/services/setup
sudo ./install-firstrun.sh
```

Ce script :
1. Met le hostname à `aibox`
2. Installe et configure Avahi (`aibox.local` annoncé en mDNS)
3. Installe le service systemd `aibox-firstrun.service` (enabled au boot)
4. Démarre le wizard immédiatement si pas déjà configuré

## Installation chez le client (au déballage)

Le client n'a **rien** à installer. Il :
1. Branche la box au réseau
2. L'allume
3. Sur son poste, ouvre `http://aibox.local`
4. Suit le wizard (5 minutes)
5. À la fin : a un compte avec son login + mdp choisi, peut commencer à utiliser

## Endpoints API du wizard

| Méthode | URL | Rôle |
|---|---|---|
| GET | `/` | Wizard (ou redirect vers `/configured` si déjà fait) |
| GET | `/configured` | Page d'accueil post-setup (liens vers les apps) |
| GET | `/api/state` | `{configured: bool}` |
| GET | `/api/questionnaire` | Structure du questionnaire 11 chapitres |
| POST | `/api/configure` | Reçoit la config, écrit `.env` + `client_config.yaml` |
| POST | `/api/deploy/start` | Lance `docker compose up` |
| POST | `/api/deploy/create-admin-user` | Crée le user dans Authentik avec le mdp saisi |
| POST | `/api/configure/finish` | Marque la box configurée |
| WS | `/api/deploy/logs` | Stream le log de déploiement |

## Réinitialiser une box (passer en mode "first-run" à nouveau)

Utile pour un test, un reconditionnement, ou un changement de propriétaire :

```bash
sudo rm -f /var/lib/aibox/.configured
sudo docker volume rm aibox_setup_state || true
sudo systemctl restart aibox-firstrun.service
```

## Sécurité

- Le wizard n'est accessible que **tant que la box n'est pas configurée**. Une fois `/var/lib/aibox/.configured` créé, le service systemd ne démarre plus → impossible pour un attaquant de "reconfigurer" via cette URL.
- Le mot de passe administrateur saisi par le client n'est **jamais loggé** côté serveur, jamais retourné par l'API, et stocké uniquement chiffré dans Postgres (par Authentik).
- Le `.env` est `chmod 600` (lisible seulement par root).
- En production, il faudra ajouter HTTPS à Caddy pour le wizard (Let's Encrypt local impossible sans domaine public, donc certificat auto-signé acceptable pour LAN).

## Roadmap

- [x] v0.1 : wizard 5 étapes, génération `.env`, déploiement
- [ ] v0.2 : poll d'état réel (au lieu de timeout 15s)
- [ ] v0.3 : détection auto du hardware (CPU/RAM/GPU) → préselection profil
- [ ] v0.4 : assistant réseau (Wi-Fi/Ethernet, IP statique vs DHCP)
- [ ] v0.5 : import depuis le portail externe (le revendeur préconfigure, le client confirme)
- [ ] v1.0 : HTTPS auto-signé + UX 100% client final
