# Durcissement réseau — état des lieux et reste-à-faire

> Rédigé lors du hardening 0.3.0 (2026-06-12). Items vérifiés mais NON
> modifiés cette nuit-là, soit parce qu'ils touchent des services live
> partagés, soit parce qu'ils demandent une décision produit.

## Fait en 0.3.0

- `QDRANT_API_KEY` rendue obligatoire (`${VAR:?}`) dans le compose racine —
  un `.env` incomplet ne lance plus un Qdrant sans auth sur le LAN.
- Auth ajoutée sur les routes `system/*` qui fuyaient des infos
  (github-status, check-updates, update-status) — voir CHANGELOG 0.3.0.
- Secrets connecteurs et tokens OAuth chiffrés at-rest.

## Reste à faire (par ordre de priorité)

### 1. Ollama exposé 0.0.0.0:11434 sans auth
Tous les consommateurs internes passent par le réseau Docker
(`http://ollama:11434` — vérifié dans les 15 composes). Le bind host ne
sert qu'au debug. MAIS sur xefia, le container `ollama` appartient à la
stack legacy Portainer (`/srv/xefia/`), pas à BoxIA → changer
`services/inference/docker-compose.yml` n'affecte que les installs
fraîches. À faire :
- `services/inference/docker-compose.yml` : `127.0.0.1:11434:11434`.
- Vérifier qu'aucun client LAN (poste dev, Hermes ?) ne tape l'IP:11434.
- Sur xefia : changer le bind dans la stack Portainer.
N'importe quel poste du LAN client peut aujourd'hui `DELETE /api/delete`
les modèles ou saturer le GPU.

### 2. Login Authentik en HTTP clair (port 9000)
Tous les mots de passe transitent en clair sur le LAN. Router le login
via l'edge Caddy TLS et binder 9000 sur 127.0.0.1. Demande de tester le
flow OIDC complet (issuer URLs dans .env + Authentik).

### 3. setup-api : docker.sock RW + port 80 + restart unless-stopped
Si le wizard n'est pas stoppé après configuration, équivalent root
accessible LAN. Le handoff doit `docker compose down` le setup, ou le
service doit s'auto-désactiver après configuration réussie.

### 4. docker.sock dans aibox-app et authentik-worker
`:ro` sur le socket n'empêche PAS les requêtes mutatives à l'API Docker.
Piste : proxy filtrant (tecnativa/docker-socket-proxy) n'autorisant que
`containers/{ps,logs,restart}` pour aibox-app.

### 5. N8N_ENCRYPTION_KEY = DIFY_SECRET_KEY
Secret partagé entre deux services. Générer une clé dédiée dans
install.sh. ATTENTION migration : changer la clé sur une box existante
casse les credentials n8n chiffrés — à faire uniquement sur fresh
install (gate sur présence de n8n_data).

### 6. Défauts faibles restants dans les composes
`langfuse_dev_change_me`, Grafana `changeme`, `SEARXNG_SECRET` par
défaut, `difyai123456` (agents-autonomous). Passer en `${VAR:?}` une
fois vérifié que install.sh genère bien chaque var (sinon fresh install
casse).
