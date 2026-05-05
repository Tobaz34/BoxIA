# AI Box — Sandbox d'exécution code (P0 #1)

> Service Python + FastAPI qui exécute bash / python soumis par les agents
> IA dans un environnement isolé multi-couches.

Référence : [audit P0 #1](../../tools/research/audit_P0_01_sandbox.md)
+ [DECISIONS-P0.md](../../tools/research/DECISIONS-P0.md) §D1 (gVisor)
+ §D7 (`bash_exec` is_sensitive_action=true).

## ⚠️ Pré-requis avant déploiement (Sprint 0 S0.4)

**POC `runsc` (gVisor) sur xefia obligatoire** :

```bash
# Sur xefia
sudo apt-get install -y runsc          # ou télécharger depuis GitHub gVisor
sudo runsc install                     # ajoute le runtime à Docker daemon
sudo systemctl restart docker

# Test smoke :
docker run --rm --runtime=runsc python:3.12-slim python -c "import os; print(os.uname())"
```

Si gVisor échoue (kernel custom, secomp bloquant) → fallback `nsjail` :
- Plan B documenté dans [audit P0 #1](../../tools/research/audit_P0_01_sandbox.md)
- Override via `SANDBOX_RUNTIME=runc` dans .env (sécurité dégradée — uniquement si gVisor refuse de tourner)

## API

Auth `Authorization: Bearer $AGENTS_API_KEY` sur tous les endpoints.

### POST /v1/exec

```json
{
  "lang": "python",
  "code": "import pandas as pd\ndf = pd.DataFrame({'a':[1,2,3]})\ndf.to_excel('/tmp/work/out.xlsx')\nprint('done')",
  "timeout_seconds": 30,
  "session_id": "convA_step1",
  "env": {"CLIENT_NAME": "Pinacle"}
}
```

Response :

```json
{
  "ok": true,
  "stdout": "done\n",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 412,
  "timed_out": false,
  "stdout_truncated": false,
  "stderr_truncated": false,
  "files_created": [{"name": "out.xlsx", "size": 5120}],
  "runtime_info": {
    "lang": "python",
    "timeout_s": 30,
    "session_id": "convA_step1",
    "ephemeral": false
  }
}
```

### DELETE /v1/sessions/<session_id>

Cleanup explicite d'un workdir persistant.

### GET /healthz

Smoke test + détection runtime (gvisor / runc inférée depuis /proc/version).

## Sécurité multi-couches

| Couche | Mécanisme |
|---|---|
| Process isolation | gVisor (`runsc` runtime) — kernel userspace réimpl |
| Filesystem root | `read_only: true` dans compose |
| Filesystem /tmp | tmpfs `noexec,nosuid` 128 MB |
| Filesystem /tmp/work | tmpfs `nosuid` 256 MB (writable pour le user code) |
| Network | `network_mode: none` par défaut (override env `SANDBOX_ALLOW_NETWORK=true`) |
| Capabilities | `cap_drop: ALL` |
| Privilege escalation | `no-new-privileges:true` |
| Resources | 512 MB RAM, 1 CPU, 64 PIDs max |
| Timeout | 30s default, 300s max (cap dur) |
| Auth | Bearer AGENTS_API_KEY (refuse si non configuré) |
| Path traversal | `session_id` regex strict `[a-zA-Z0-9_-]{1,40}` |
| Secret leak | env vars : refuse les noms PASSWORD/SECRET/TOKEN/API_KEY |
| Output | stdout cap 64 KB, stderr cap 32 KB (truncation flag exposé) |
| Files créés | listing limité à 50 entrées |

## Libs Python pré-installées

(image build, l'utilisateur ne peut pas pip install — sandbox read-only)

- `pandas` 2.2.3 — analyses tabulaires
- `openpyxl` 3.1.5 — XLSX
- `reportlab` 4.2.5 — PDF
- `requests` 2.32.3 — HTTP (uniquement utilisable si SANDBOX_ALLOW_NETWORK=true)
- `beautifulsoup4` 4.12.3, `lxml` 5.3.0 — parsing
- `python-docx` 1.1.2 — DOCX
- `pypdf` 5.0.1 — lecture PDF
- `pillow` 11.0.0 — images

## Wiring côté Concierge (futur — pas encore livré)

Tool route à ajouter : `services/app/src/app/api/agents-tools/bash_exec/route.ts`
- POST /v1/exec sur sandbox
- isSensitive=true (cf TOOL_META) → passe par approval-gate AVANT exec
- audit_context propagé pour SafetyAuditor (P0 #3)
- Retour formaté pour le LLM : `{ok, stdout, stderr, files: [{name, download_url}]}`
- Si `files_created` non-vide → upload sur /data/generated/ + génère
  marker `[FILE:<name>]<base64>[/FILE]` que MessageMarkdown render en chip download

## Limites V1

- Pas de scheduler intégré (utiliser services/scheduler avec action_type=tool_call)
- Pas de partage de workdir cross-conversation (session_id strictement dans un même container)
- Pas de pip install à chaud (volontairement — read-only)
- Pas de exécution shell `&&`/pipes via le wrapper (l'utilisateur peut le faire DANS son code, pas via la commande wrapper)
- gVisor overhead ~+20% CPU (acceptable pour usage TPE/PME)

## Tests

À ajouter (Phase 4) :
- `tests/test_validation.py` : zod-style validation lang/timeout/session_id/env
- `tests/test_exec.py` : smoke run python+bash, timeout, exit_code, stdout truncation
- `tests/test_security.py` : path traversal session_id, secret env names, network blocked

## Reset client

Le volume tmpfs disparaît au restart container — pas de persistence.
Pas d'action requise dans `reset-as-client.sh`.
