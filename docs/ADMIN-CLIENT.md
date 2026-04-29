# Guide administrateur — AI Box

> Pour l'IT du client final (ou son prestataire d'infogérance).

## Architecture

```
┌─────────────────────────────────────────────┐
│  Edge Caddy (80/443) ─ TLS Let's Encrypt    │
├─────────────────────────────────────────────┤
│  auth.   chat.   agents.   flows.           │
│  Authentik OWUI Dify n8n                    │
├─────────────────────────────────────────────┤
│  Ollama (GPU) ─ Qdrant ─ Postgres ─ Redis   │
├─────────────────────────────────────────────┤
│  Connecteurs activés (selon wizard)         │
│  rag-msgraph / email-* / erp-odoo / ...     │
├─────────────────────────────────────────────┤
│  Monitoring : Prometheus / Loki / Grafana   │
│  Backup : Duplicati → NAS + cloud chiffré   │
└─────────────────────────────────────────────┘
```

## Connexion SSH

L'administrateur (toi) reçoit du prestataire :
- Adresse IP de la box (LAN / Tailscale)
- Utilisateur : `clikinfo` (par défaut, configurable)
- Clé SSH publique → ajouter ta clé dans `~/.ssh/authorized_keys`

```bash
ssh clikinfo@<IP-box>
```

## Commandes courantes

| Action | Commande |
|---|---|
| Voir tous les containers | `docker ps` |
| Logs d'un service | `docker logs -f <nom>` |
| Redémarrer un service | `docker restart <nom>` |
| Voir l'état général | `cd /srv/ai-stack && docker compose ps` |
| Voir l'utilisation GPU | `nvidia-smi` ou Grafana dashboard "GPU" |
| Backup manuel | `cd /srv/ai-stack && ./backup.sh` |
| Lister backups | `ls /srv/aibox-backups/` |
| Restaurer un backup | `./backup.sh restore <YYYY-MM-DD_HH-MM-SS>` |
| Mise à jour | `./update.sh` (backup auto avant) |
| Voir les logs centralisés | Grafana → Explore → Loki |

## Mise à jour

**Toujours via `./update.sh`** — jamais de `--force-recreate` manuel. Le script :
1. Lance `backup.sh quick` automatiquement
2. Pull les nouvelles images
3. Restart en place (sans reseter les volumes)

Pour mettre à jour un connecteur seul :

```bash
cd /srv/ai-stack/services/connectors/<nom>
docker compose pull && docker compose up -d
```

## Ajouter / modifier un connecteur

1. Cocher la techno dans Authentik > Settings (ou ré-ouvrir le wizard, voir "Reset wizard" plus bas)
2. Renseigner les credentials (M365 OAuth, Google SA, IMAP, etc.) dans `/srv/ai-stack/.env`
3. Lancer le dispatcher :
   ```bash
   python /srv/ai-stack/services/connectors/dispatcher/dispatch.py --apply
   ```

## Reset du wizard (recommencer le setup)

```bash
sudo rm /var/lib/aibox/.configured
sudo docker volume rm aibox_setup_state
sudo systemctl restart aibox-firstrun
```

Le wizard sera de nouveau accessible sur `http://aibox.local`.

⚠️ **Cela ne supprime pas les données utilisateur** (chats, RAG, comptes Authentik). Pour reset complet :

```bash
cd /srv/ai-stack && docker compose down -v   # SUPPRIME LES DONNÉES
```

## Monitoring

Grafana : `https://status.<DOMAIN>` ou `http://<IP>:3000` (admin/<mdp .env>)

Dashboards livrés :
- **Système** : CPU, RAM, disque, réseau
- **GPU** : utilisation, mémoire, température
- **Containers** : usage par container (cAdvisor)
- **LLM** : tokens/min, latence Ollama, modèles en mémoire
- **Logs** : Loki Explore — recherche full-text dans tous les logs containers

## Sauvegardes

### Local (par défaut)
- Snapshot quotidien dans `/srv/aibox-backups/`
- Conservation : 7 jours (auto-purge)
- Inclut : volumes Qdrant, Postgres, MinIO, Open WebUI data

### Offsite (configurable au wizard)
Si renseigné dans `.env` (`BACKUP_REMOTE_TYPE` + creds) :
- Duplicati pousse les backups chiffrés vers Wasabi / B2 / S3 / SFTP
- Chiffrement AES-256 avec passphrase générée à l'install
- Test de restauration : `./backup.sh restore <stamp>` après `docker compose down`

## Sécurité

### Vérifier les accès admin
- Authentik > Directory > Users : liste tous les users
- Authentik > Events > Logs : connexions, échecs, modifications

### Faire tourner les secrets
Tous les ~6 mois :

```bash
cd /srv/ai-stack
# Régénérer un secret particulier
sed -i "s/^DIFY_SECRET_KEY=.*/DIFY_SECRET_KEY=$(openssl rand -base64 36)/" .env
docker compose restart dify-api dify-worker
```

### Mettre à jour les modèles Ollama
```bash
docker exec ollama ollama pull qwen2.5:7b   # tag = latest
```

## Troubleshooting

### "Le chat répond très lentement"
- Vérifier Grafana → GPU : si saturée, considérer un modèle plus petit
- `docker exec ollama ollama ps` → voir si plusieurs modèles chargés
- `docker exec ollama ollama stop <modele>` → libère la VRAM

### "Le RAG ne trouve pas mes nouveaux documents"
- Vérifier les logs du connecteur : `docker logs aibox-conn-rag-<X>`
- Forcer une re-sync : `docker restart aibox-conn-rag-<X>`
- Re-créer la collection Qdrant si corruption : voir docs Qdrant

### "Authentik dit 'Permission denied'"
- Vérifier user → groupe → application policy dans Authentik
- Vérifier que le forward_auth Caddy est bien actif

### "Le wizard est toujours là alors que la box est déjà configurée"
```bash
sudo touch /var/lib/aibox/.configured
sudo docker stop aibox-setup-caddy aibox-setup-api
```
