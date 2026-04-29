# Opérations & procédures sécurisées

> Document interne. À lire avant toute intervention sur un serveur AI Box en production.

## ⚠️ Règle d'or

**Toujours `./backup.sh` AVANT toute opération qui touche un container.** Coût : 30-60s. Bénéfice : pas de perte de données possible.

## Incident de référence — 2026-04-28

Un `docker compose -p stack_xefia up -d --force-recreate open-webui` a eu pour effet collatéral de recréer ollama (via `depends_on`) et de l'attacher à un volume vide nouvellement créé (`stack_xefia_ollama_data`). Résultat : modèles Ollama freshly téléchargés (qwen2.5:7b, bge-m3) supprimés.

### Cause racine (3 facteurs combinés)

1. **Volumes non-externes dans le compose** : `volumes: ollama_data:` (sans `external: true`) → Compose préfixe le nom avec le project_name actif.
2. **Project_name basculé** : avant l'incident, ollama tournait sur un volume géré par un autre project. Avec `-p stack_xefia`, Compose a cherché un nom différent et l'a créé vide.
3. **`--force-recreate` propage aux dépendances** : `depends_on: [ollama]` a entraîné la recréation d'ollama avec le nouveau volume vide.

### Corrections appliquées

- ✅ Compose `services/inference/docker-compose.yml` créé avec **tous les volumes en `external: true` + `name:` explicite**
- ✅ Migration d'ollama et open-webui sur ce compose
- ✅ `backup.sh` créé : snapshot tous les volumes critiques en 30s
- ✅ `update.sh` créé : procédure de mise à jour qui n'utilise JAMAIS `--force-recreate`
- ✅ Cette doc

## Procédures

### Mise à jour des images

```bash
cd /srv/ai-stack
./update.sh
```

Ce script :
1. Lance `./backup.sh` automatiquement avant
2. Pull les nouvelles images
3. Fait un `docker compose up -d` (Compose ne recrée que si l'image a changé — pas de remontage de volumes vides)
4. Affiche l'état final

### Backup manuel

```bash
./backup.sh           # backup standard de tous les volumes critiques
./backup.sh quick     # rapide, juste les DBs (pas les modèles Ollama)
./backup.sh restore <timestamp>   # restore depuis un backup donné
```

Les backups vivent dans `/srv/aibox-backups/<YYYY-mm-dd_HH-MM-SS>/`. Conservation : 7 derniers backups (auto-purge).

### Restauration

```bash
ls /srv/aibox-backups/      # lister les backups dispos
./backup.sh restore 2026-04-28_22-00-10
```

⚠️ Restore = STOP des containers utilisant les volumes restaurés. Toujours redémarrer après :

```bash
cd /srv/ai-stack && docker compose up -d
( cd services/inference && docker compose --env-file ../../.env up -d )
( cd services/authentik && docker compose --env-file ../../.env up -d )
( cd services/dify && docker compose --env-file ../../.env up -d )
```

### Ajouter un nouveau service à la stack

1. Créer `services/<nom>/docker-compose.yml`
2. **OBLIGATOIRE** : tous les volumes data en `external: true` + `name: aibox_<nom>_<volume>`
3. **OBLIGATOIRE** : se brancher sur le network `aibox_net` en `external: true`
4. Référencer dans `update.sh` (ajouter une ligne `( cd services/<nom> && ... )`)
5. Ajouter les volumes critiques dans `CRITICAL_VOLUMES` de `backup.sh`

## Anti-patterns à NE JAMAIS faire

| ❌ Don't | ✅ Do |
|---|---|
| `docker compose up -d --force-recreate` | `docker compose up -d` (recrée seulement si nécessaire) |
| `volumes: foo:` (sans external) | `volumes: foo: { name: aibox_xxx, external: true }` |
| Passer un `-p projectname` différent à chaque commande | Utiliser le `name:` au top du compose pour figer le project |
| `docker rm -v <container>` | `docker rm <container>` (jamais `-v` qui supprime les volumes anonymes) |
| Modifier directement les containers via Portainer sans repercuter dans le compose | Toujours éditer le compose dans le repo Git puis redéployer |

## Recovery rapide (si un container ne démarre plus)

1. **Identifier le service** : `docker compose ps`, `docker logs <container>`
2. **Backup d'abord** : `./backup.sh`
3. **Tenter restart** : `docker restart <container>`
4. **Si toujours KO** : recreate le service spécifique : `docker compose up -d --no-deps <service>`
5. **Si vraiment cassé** : restore depuis le dernier backup et investiguer.

## Monitoring quotidien

- **Uptime Kuma** (`https://192.168.15.210:3001`) : alerte si un service ne répond plus
- **Portainer** (`https://192.168.15.210:9443`) : vue containers + logs
- **Grafana** *(à venir)* : métriques GPU/CPU/RAM/requêtes

## Contacts internes

- **Backups offsite** : à configurer dans Duplicati (cible : NAS client + cloud Wasabi/B2)
- **Support N1** : (toi)
- **Support N2 / éditeurs** : Authentik, Dify, OWUI (issues GitHub)
