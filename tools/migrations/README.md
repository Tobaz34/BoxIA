# tools/migrations/ — Mutations DB live, idempotentes et versionnées

## Pourquoi ce dossier existe

L'AI Box repose sur 3 bases de données live qui doivent être synchrones avec le code applicatif :

- **PostgreSQL Dify** (`aibox-dify-postgres`) — apps, workflows, tools, MCP servers, agents
- **PostgreSQL n8n** (`aibox-n8n-postgres`) — credentials, workflows, executions
- **PostgreSQL Authentik** (`aibox-authentik-postgres`) — users, groups, providers OIDC

Quand le code applicatif change le schéma attendu (nouveau champ dans une app Dify, nouveau credential type n8n, nouvelle classe d'utilisateur Authentik…), il faut **muter ces DBs live**.

**Règle absolue** : aucune mutation DB ne se fait via `psql -c "UPDATE ..."` ou un script `tools/patch_xxx.py` qu'on lance et qu'on oublie. Toutes les mutations passent par un fichier ici.

## Format des migrations

```
tools/migrations/
├── README.md                            # ce fichier
├── _state.json                          # liste des migrations appliquées (mutée par run-pending.py)
├── run-pending.py                       # runner — joue les migrations non encore appliquées
├── 0001_dify_max_tokens_8192.py         # une migration = un script Python idempotent
├── 0002_n8n_credential_facebook.py
└── ...
```

## Convention de nommage

`<NNNN>_<short_description>.py` — NNNN = numéro à 4 chiffres incrémental, jamais réutilisé.

## Anatomie d'une migration

Chaque script DOIT :

1. Exposer une fonction `run() -> None` (point d'entrée)
2. Exposer une fonction `is_applied() -> bool` (vérifie si déjà fait, pour idempotence)
3. Exposer une constante `DESCRIPTION: str` (1 ligne, affichée dans les logs)
4. Être **strictement idempotent** : `run()` peut être appelé N fois, l'effet est le même
5. Ne **pas** modifier le schéma SQL (laisser ça aux migrations Dify/n8n natives) — uniquement
   muter la **donnée** (ex: forcer `max_tokens=8192` sur les apps existantes, créer un
   credential par défaut, activer un provider OIDC, etc.)

## Comment ajouter une migration

1. Crée le fichier `<NNNN+1>_<desc>.py` (NNNN = dernière migration existante)
2. Implémente `is_applied()`, `run()`, `DESCRIPTION`
3. Teste localement contre une DB de test (jamais directement sur la prod la première fois)
4. Commit + push
5. Au prochain `tools/deploy-to-xefia.sh <branche>`, le script `run-pending.py` est appelé
   automatiquement après le rebuild — il joue toutes les migrations non encore appliquées
   selon `_state.json`

## Comment rejouer toutes les migrations (après un reset client)

Le script `reset-as-client.sh` (ou son équivalent futur) doit appeler à la fin :

```bash
python3 tools/migrations/run-pending.py --reset-state
```

Le flag `--reset-state` réinitialise `_state.json` et rejoue **toutes** les migrations dans
l'ordre. Comme elles sont idempotentes, c'est safe.

## Lien avec le code applicatif

Les migrations **ne remplacent pas** le code de provisioning initial (ex: `services/setup/app/sso_provisioning.py`).
Elles complètent : le code de provisioning crée l'état initial, les migrations gèrent les changements
ultérieurs sur des installations déjà déployées.

Si tu changes une valeur par défaut dans le provisioning (ex: `max_tokens` 2048 → 8192), tu dois :

1. Modifier le code de provisioning (pour les nouvelles installations)
2. Créer une migration (pour les installations existantes)

C'est le seul moyen de garder le code source comme source de vérité **et** de ne pas casser la démo client.
