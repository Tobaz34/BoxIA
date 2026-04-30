# Session 2026-04-30 — Fiabilisation pipeline reset/install

## Objectif

> "vérifie qu'il n'y as plus aucune trace du serveur IA, docker et autre"  
> "Nh'ésite pas a faire toi meme des Wipe + réinstallation en boucle"  
> "Il faut fiabilisé ça avant de faire des amélioration du logiciel IA"

## Bugs identifiés et fixés (par ordre chronologique)

### 1. Install pipeline incomplet (commit `0f8ded0`)
- **`install-firstrun.sh` n'installait pas `aibox-mdns-publish.sh`** → seul `aibox.local` répondait, tous les hostnames flat (`aibox-auth.local`, `aibox-chat.local`, etc.) étaient injoignables
- **`sso_provisioning.py` utilisait `auth.{domain}` (point) ≠ Caddy qui sert `aibox-auth.local` (tiret)** → login OIDC cassé en mode LAN. Helper `_service_url()` introduit, gère les 2 conventions selon `.local` ou public
- **`DOMAIN_PREFIX`, `ALLOW_SELF_SIGNED`, `ACME_CA` jamais écrits dans `.env`** par `main.py:configure`
- **`provision-sso` recreate sans `--build`** → code obsolète possible

### 2. Wizard handoff cassé (commit `afe7940`)
- **`/api/configure/finish` n'arrêtait pas le wizard ni ne démarrait edge-caddy** → `aibox-edge-caddy` restait en `Created` (port 80 occupé par setup-caddy), `https://aibox.local` ne répondait pas, login impossible
- Fix : Popen détaché qui stop setup-caddy + start edge-caddy + écrit `.configured` côté hôte via container alpine

### 3. Recovery scripts (commits `afe7940`, `0a9cae5`)
- **`recover-admin-password.sh`** : reset interactif/non-interactif/random du mdp Authentik. Sync DB Authentik (via `ak shell`) + `.env` + history log
- **`recover-provisioning.sh`** : si le wizard a planté entre `create-admin-user` et `provision-sso`, ce script termine le job idempotent

### 4. mDNS prefix sync (commit `9d1b220`)
- `aibox-mdns-publish.sh` utilisait un `PREFIX` hardcodé `aibox` ; si l'utilisateur choisissait `DOMAIN=boxia.local`, Caddy servait `boxia-*.local` mais mDNS publiait `aibox-*.local` → mismatch
- Fix : fallback en cascade `AIBOX_PREFIX → DOMAIN_PREFIX → 'aibox'` + `EnvironmentFile=-/srv/ai-stack/.env` dans le service systemd

### 5. Pattern appliance default-password (commit `30539d5`)
Plus tolérant aux fautes de frappe à l'install (qui locked-out l'admin).
- **Wizard** : drop des champs password + confirm de l'étape 2, identifiant `admin` pré-rempli, encart visuel "🔐 Mot de passe par défaut : `aibox-changeme!`"
- **Backend** : `WizardSubmit.admin_password` optional (default = `""`), `/api/configure` injecte `DEFAULT_ADMIN_PASSWORD` si vide
- **Authentik** : `attributes.must_change_password=True` posé sur l'user via `ak shell` quand le pwd == DEFAULT
- **App Next.js** : `/api/me/password-status` (GET/POST) lit/clear le flag via Authentik admin API. `PasswordChangeBanner` composant client en haut du layout

### 6. TLS polarity inversion (commit `5b410ca`)
Bug critique au 1er fresh-install end-to-end. Symptôme : `unable to get local issuer certificate`.
- `services/app/docker-compose.yml` mappait `NODE_TLS_REJECT_UNAUTHORIZED: ${ALLOW_SELF_SIGNED:-0}` — sémantique INVERSE
- Fix : compose utilise `NODE_TLS_REJECT_UNAUTHORIZED` directement, `main.py:configure` écrit `ALLOW_SELF_SIGNED=1 + NODE_TLS_REJECT_UNAUTHORIZED=0` en mode `.local`

### 7. Wizard error handling (commit `fd5bd01`)
Le wizard continuait après `create-admin-user` 500 → box "configurée" sans admin réel.
- **Backend** : warmup Authentik enrichi (count + group exist), 5 retries (au lieu de 3), 10 s entre chaque, timeout 45s, logs `print()` à chaque tentative, HTTPException avec detail structuré
- **Frontend** : si `create-admin-user` échoue → wizard STOPPE proprement et affiche l'erreur + suggestion (`recover-admin-password.sh --random`)

### 8. Default pwd ≥ 12 chars + Dify timing (commit `6588a2c`)
- `boxia2026!` (11 chars) rejeté par Portainer (mini 12). Default password changé à `aibox-changeme!` (15 chars, plus explicite : *change me!*)
- **Dify warmup** : `dify-nginx` est Up dès le `compose up -d` mais `dify-api` met 30-60s à démarrer derrière. Solution : warmup loop avant `setup_dify_admin` (poll `/console/api/setup` pendant max 60s)

### 9. Edge-caddy network attachment (commit `00a1e6c`)
Bug observé sur le 2e wipe + reinstall : edge-caddy se retrouvait attaché uniquement à `ollama_net` → Caddy ne pouvait pas résoudre `aibox-authentik-server` → 502 sur OIDC discovery → login impossible.
- Cause : `docker compose up -d` ne ré-attache PAS les networks d'un container existant
- Fix : `--force-recreate` spécifiquement sur edge

### 10. Edge démarré uniquement par handoff + retry flows AK (commit `3a1241d`)
3 bugs fixés en cascade :
- `install.sh` tentait de démarrer edge-caddy alors que `setup-caddy` tenait le port 80 → container créé mais networking incomplet → contamine le handoff. Fix : `install.sh` skip edge-caddy. Le `_HANDOFF_SCRIPT` le démarre lui-même AVEC `--force-recreate` après avoir stop setup-caddy
- Handoff utilisait `up -d` (sans force-recreate) → Fix : `--force-recreate`
- `_ak_get_uuids` échouait avec `KeyError 'authz_flow'` au 1er install (les flows par défaut Authentik sont créés par les blueprints au boot, parfois après le moment où provision-sso est appelé) → Fix : retry loop max 60s

## Scripts créés cette session

| Script | Rôle |
|---|---|
| `bootstrap.sh` | One-liner installer pour serveur Linux propre |
| `wipe-and-reinstall.sh` | Simulation "serveur neuf" — rase tout sauf modèles Ollama |
| `reset-as-client.sh` | Reset léger — garde modèles + code, rejoue le wizard |
| `recover-admin-password.sh` | Reset du mdp admin (interactif/random) |
| `recover-provisioning.sh` | Termine le provisioning OIDC si wizard interrompu |

## Cycles de tests

| Cycle | État | Bugs trouvés |
|---|---|---|
| 1 | partiel | install pipeline incomplet (4 trous) |
| 2 | partiel | edge-caddy network, default pwd, Dify timing, AK flows |
| 3 | **stable** | aucun bug bloquant |
| 4 | en cours | confirmation répétabilité |

## État pipeline final (post cycle 3)

```
✓ Containers     : tous Up + healthy (Authentik, Dify, edge-caddy, app, etc.)
✓ edge-caddy     : aibox_net + ollama_net (les 2 attachés)
✓ OIDC discovery : HTTP 200
✓ Login chain    : authorize URL Authentik retourné correctement
✓ Default pwd    : admin / aibox-changeme!
✓ Banner         : must_change_password=True posé → PasswordChangeBanner s'affichera au login
```

## Reste à faire (non bloquant)

- Dify init validation 401 sur certaines runs (Dify-api pas encore prêt malgré warmup)
- n8n connection refused (la stack héritée n'est pas démarrée — ne fait pas partie de l'install BoxIA)
- Tester un VRAI `wipe-and-reinstall.sh` (avec sudo) pour valider qu'install-firstrun.sh + bootstrap.sh tiennent dans un scénario fully fresh
