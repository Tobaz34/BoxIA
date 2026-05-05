# AI Box — Scheduler service (P1 #6)

> Sidecar Python qui permet aux agents IA de programmer des tâches
> récurrentes (cron / interval) sans passer par n8n.

Référence : `tools/research/00_SYNTHESE.md` §P1 #6 + audit Local Operator
(`scheduler_service.py`, MIT — pattern réimplémenté en FastAPI + APScheduler).

## Stack

- Python 3.12 + FastAPI + APScheduler 3
- SQLite local `/data/scheduler.db` (D2 décision filesystem, pas Postgres)
- httpx pour appeler aibox-app au moment du trigger
- TZ par défaut Europe/Paris (configurable)

## API

Toutes les routes nécessitent `Authorization: Bearer $AGENTS_API_KEY`.

### POST /v1/schedules

Crée un job. Body :

```json
{
  "name": "Résumé Outlook matinal",
  "description": "Résume mes 10 derniers emails non lus chaque matin",
  "user_id": "andre@xefi.fr",
  "trigger": {
    "cron": "0 8 * * 1-5"
  },
  "action": {
    "type": "agent_message",
    "agent_slug": "general",
    "query": "Résume mes 10 derniers emails non lus dans Outlook et donne-moi les actions prioritaires."
  },
  "enabled": true
}
```

Trigger : `cron` (5-field) OU `interval_seconds` (60-2592000).

Action types :
- `http_post` — POST sur `url` avec `body` JSON
- `agent_message` — appelle `/api/chat` aibox-app avec `agent_slug` + `query`
- `tool_call` — appelle `/api/agents-tools/<tool_name>` avec `tool_args`
- `n8n_workflow` — POST sur webhook n8n

### GET /v1/schedules?user_id=...

Liste les jobs (filtre user_id optionnel — admin sans filtre voit tout).

### GET /v1/schedules/<id>

Détail d'un job + dernière exécution (next_run_at, last_run_at, last_run_status,
last_run_error).

### DELETE /v1/schedules/<id>?user_id=...

Annule + supprime. Le `user_id` query param vérifie ownership (sauf admin).

### GET /healthz

Smoke test : `{ok, scheduler_running, jobs_count}`.

## Déploiement

```bash
cd services/scheduler
docker compose up -d
```

Container expose `127.0.0.1:8086` (jamais LAN). Réseau `aibox_net`.

## Garde-fous

- `MAX_JOBS_PER_USER=20` (env, anti-spam) — refuse 429 si dépassé
- `min interval_seconds = 60s` (anti-flood)
- `max interval_seconds = 30 jours`
- Validation cron 5-field obligatoire

## Observabilité

- Log structuré `[INFO]` à chaque create/delete/run
- Status persisté en DB : `last_run_status` ∈ {success, error}
  + `last_run_error` (300 chars max)
- Healthcheck Docker via `/healthz`

## Wiring côté Concierge (futur — pas encore livré)

3 tools agents-tools à ajouter dans `services/app/src/app/api/agents-tools/` :
- `schedule_task/route.ts` → POST /v1/schedules
- `list_schedules/route.ts` → GET /v1/schedules?user_id=...
- `stop_schedule/route.ts` → DELETE /v1/schedules/<id>

Plus migration `0016_concierge_scheduler_prompt.py` qui ajoute
`[SCHEDULER-V1]` au pre_prompt Concierge avec exemples d'usage.

## Reset client

`reset-as-client.sh` doit purger le volume `aibox_scheduler_data` pour
repartir à 0 (sinon les jobs du précédent client tournent toujours).

## Limites V1

- Pas de retry automatique sur fail (le job tourne au prochain trigger)
- Pas de pause/resume API (delete + recreate seulement)
- Pas de timezone par job (tous en TZ container)
- Pas de notification email sur fail (à brancher via n8n workflow si besoin)
