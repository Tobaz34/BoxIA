# Edge — reverse proxy + TLS

**Caddy 2** prend `:80` et `:443` et expose toute la stack AI Box derrière des sous-domaines propres avec TLS automatique.

## Sous-domaines exposés

| Sous-domaine | Service | Note |
|---|---|---|
| `auth.<DOMAIN>` | Authentik | SSO + dashboard apps |
| `chat.<DOMAIN>` | Open WebUI | Chat utilisateur (avec WebSocket) |
| `agents.<DOMAIN>` | Dify | Agent builder |
| `flows.<DOMAIN>` | n8n | Workflows |
| `admin.<DOMAIN>` | Portainer | Admin containers (sera protégé par forward_auth Authentik) |
| `status.<DOMAIN>` | Uptime Kuma | Monitoring uptime |
| `qdrant.<DOMAIN>` | Qdrant | Dashboard RAG (protégé par forward_auth) |
| `<DOMAIN>` | redirect | → `auth.<DOMAIN>/if/user/` (dashboard Authentik) |

## Modes TLS

### Domaine public (production chez client)

```bash
# Dans .env :
DOMAIN=ai.monclient.fr
ADMIN_EMAIL=admin@monclient.fr
ACME_CA=https://acme-v02.api.letsencrypt.org/directory
```

Le DNS du client doit pointer ses sous-domaines vers l'IP de la box (ou un Cloudflare Tunnel). Caddy obtient automatiquement les certs Let's Encrypt.

### Test (LAN, dev)

```bash
# Dans .env :
DOMAIN=aibox.local
ACME_CA=internal     # certs auto-signés par Caddy
```

Le navigateur affichera un warning de sécurité (cert non reconnu) — accepter en mode dev.

### Staging Let's Encrypt (debug)

```bash
ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
```

Pour tester l'ACME sans hit de rate limit Let's Encrypt prod.

## Conflit avec NPM existant

Si NPM tourne déjà sur `:80/:443`, il faut le stopper avant de démarrer Caddy :

```bash
docker stop nginx-proxy-manager
```

Plus tard tu pourras `docker rm nginx-proxy-manager` une fois sûr que Caddy fait le job.

## Démarrage

```bash
cd /srv/ai-stack/services/edge
docker compose --env-file ../../.env up -d
```

## Vérification

```bash
# Healthcheck simple
curl http://<IP>/healthz

# Vérifier qu'un sous-domaine répond (avec --resolve si DNS pas encore propagé)
curl -k --resolve auth.ai.monclient.fr:443:<IP> https://auth.ai.monclient.fr/

# Logs Caddy
docker logs -f aibox-edge-caddy
```

## Forward auth (Authentik) — TODO

Pour protéger Portainer / Qdrant derrière l'auth Authentik :
1. Créer un **Outpost** Caddy dans Authentik (UI : Applications → Outposts → Create)
2. Activer le snippet `authentik_proxy` (commenté actuellement) dans le Caddyfile
3. Restart Caddy

À implémenter dans une prochaine itération du portail.
