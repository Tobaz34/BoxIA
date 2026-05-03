# 🔴 RÈGLES IMPÉRATIVES — À LIRE AVANT TOUTE ACTION

> Si tu es Claude (n'importe quelle session) et tu travailles sur ce repo, **ces règles ont la priorité absolue** sur toute interprétation libre. Elles sont là parce qu'on s'est déjà fait avoir : 4 sessions parallèles ont créé un chaos d'état serveur impossible à reset proprement (incident 2026-05-03).

## RÈGLE 1 — Le serveur xefia est read-only sauf via le script

**INTERDIT** :
- ❌ `ssh clikinfo@192.168.15.210 "scp ..."` ou `cp` ou `mv` ou `vim` ou `nano` ou `tee` sur `/srv/ai-stack/`
- ❌ `ssh clikinfo@192.168.15.210 "docker compose ... build|up"` direct
- ❌ `ssh clikinfo@192.168.15.210 "git checkout|reset|pull|merge"` direct
- ❌ `ssh clikinfo@192.168.15.210 "./install.sh"` ou `./reset-as-client.sh` direct

**OBLIGATOIRE** : tout déploiement passe par
```bash
tools/deploy-to-xefia.sh <branche>
```
Ce script gère le lock multi-sessions, le tag de backup, le reset propre, le rebuild ciblé, les migrations DB, le smoke test et le log d'audit.

**Lecture seule autorisée sans le script** :
- ✅ `docker ps`, `docker logs`, `docker exec ... <commande_lecture>`
- ✅ `cat`, `grep`, `ls`, `git log`, `git diff`, `git status`
- ✅ `psql -c "SELECT ..."` (jamais UPDATE/INSERT/DELETE)

## RÈGLE 2 — Toute mutation DB live est une migration versionnée

Les bases de données live (Dify Postgres, n8n Postgres, Authentik Postgres) hébergent l'état utilisateur (apps, workflows, credentials, users). **Toute modification doit survivre à un reset client.**

**INTERDIT** :
- ❌ `psql -c "UPDATE ..."` ad-hoc en SSH
- ❌ Script Python lancé une fois et oublié (style `tools/patch_xxx.py`)
- ❌ Édition manuelle via la console web Dify/n8n/Authentik (sauf si reproductible par script ensuite)

**OBLIGATOIRE** : créer un fichier dans [tools/migrations/](tools/migrations/) :
```
tools/migrations/<NNNN>_<description_courte>.py
```
Avec 3 attributs obligatoires : `is_applied()`, `run()`, `DESCRIPTION`. Idempotent. Voir [tools/migrations/README.md](tools/migrations/README.md) et l'exemple [0001_dify_max_tokens_8192.py](tools/migrations/0001_dify_max_tokens_8192.py).

Le script `deploy-to-xefia.sh` rejoue automatiquement les migrations pendantes après chaque déploiement, et le `reset-as-client.sh` rejoue tout après un client reset (`run-pending.py --reset-state`).

## RÈGLE 3 — Une seule session déploie à la fois

Plusieurs sessions Claude peuvent travailler en parallèle sur ce repo (worktrees `.claude/worktrees/<nom>/`), mais **une seule peut déployer xefia à un instant T**.

Le script `deploy-to-xefia.sh` acquiert un lock fichier `/srv/ai-stack/.deploy.lock` (TTL 10 min). Si le lock est pris :
- ✅ Vérifie qui déploie (`tools/deploy-to-xefia.sh --status`)
- ✅ Attends, ou demande au user de coordonner avec l'autre session
- ❌ Ne force JAMAIS le delete du lock sans avoir parlé à l'autre session

## Si tu ignores ces règles

Tu vas reproduire l'incident du 2026-05-03 :
- État serveur dérive de git (33 fichiers `M` dont personne ne sait l'origine)
- Patches manuels orphelins perdus au prochain reset
- Heures perdues à diagnostiquer "qui a fait quoi"
- Démo client cassée

**Pour la mémoire complète** : voir `memory/deployment_workflow.md` (chargé automatiquement dans la session).

---

## Contexte projet (rapide)

- **Produit** : AI Box — serveur IA local clé-en-main pour TPE/PME françaises
- **Serveur de démo** : xefia (192.168.15.210), 33 containers Docker live
- **Repo GitHub** : https://github.com/Tobaz34/BoxIA
- **Stack** : Next.js 15 + Authentik OIDC + Dify (LLM agents) + n8n (workflows) + Ollama (qwen3:14b/qwen2.5vl:7b) + Postgres + Qdrant
- **Approche produit** : tout passe par l'UI unifiée `aibox-app` (Dify/n8n/Authentik cachés derrière SSO seamless)

Pour plus de contexte projet, voir `memory/MEMORY.md`.
