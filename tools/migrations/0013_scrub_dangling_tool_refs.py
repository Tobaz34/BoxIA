"""Migration 0013 — purge les refs de tool providers inexistants dans
agent_mode.tools des apps Dify.

Incident 2026-06-12 : les migrations 0008/0009/0010 retombaient sur le NOM
du provider quand son id était introuvable (création 0007/0009 échouée en
HTTP 400 sur le Dify de l'install fraîche). Résultat : « Assistant
général » avait 3 tools Gmail avec provider_id="BoxIA Gmail Tools" — un
provider qui n'existe pas. Chaque chat de l'app levait alors une exception
au chargement des tools, avortait la transaction Postgres, et TOUTES les
requêtes suivantes (chat, GET/POST model-config) tombaient en 500
InFailedSqlTransaction. La fonction cœur de la box était down.

Pourquoi du SQL direct (docker exec psql) et pas la console API : la
console API GET/POST model-config sur l'app empoisonnée renvoie 500 — on
ne peut pas faire un read-modify-write par l'API. La mutation directe est
versionnée ici, conformément à la RÈGLE 2 de CLAUDE.md.

Idempotente : ne touche que les configs ACTIVES (apps.app_model_config_id)
contenant au moins une ref orpheline ; is_applied() = zéro ref orpheline.
"""
from __future__ import annotations

import subprocess
import sys

DESCRIPTION = "Purge agent_mode.tools des refs de providers inexistants (chat 500)"

PSQL = [
    "docker", "exec", "aibox-dify-db",
    "psql", "-U", "postgres", "-d", "dify", "-t", "-A",
]

# Une ref est orpheline si provider_type=api et provider_id ne matche
# aucun tool_api_providers.id (la comparaison ::text tolère les
# provider_id non-UUID comme "BoxIA Gmail Tools").
_DANGLING_PREDICATE = """
  (t.elem->>'provider_type') = 'api'
  AND NOT EXISTS (
    SELECT 1 FROM tool_api_providers p
    WHERE p.id::text = t.elem->>'provider_id'
  )
"""

COUNT_SQL = f"""
SELECT count(*)
FROM apps a
JOIN app_model_configs amc ON amc.id = a.app_model_config_id,
LATERAL jsonb_array_elements(
  COALESCE(amc.agent_mode::jsonb->'tools', '[]'::jsonb)) AS t(elem)
WHERE {_DANGLING_PREDICATE};
"""

LIST_SQL = f"""
SELECT a.name || ' :: ' || (t.elem->>'provider_id') || ' / ' || (t.elem->>'tool_name')
FROM apps a
JOIN app_model_configs amc ON amc.id = a.app_model_config_id,
LATERAL jsonb_array_elements(
  COALESCE(amc.agent_mode::jsonb->'tools', '[]'::jsonb)) AS t(elem)
WHERE {_DANGLING_PREDICATE};
"""

UPDATE_SQL = f"""
UPDATE app_model_configs amc
SET agent_mode = jsonb_set(
  amc.agent_mode::jsonb,
  '{{tools}}',
  COALESCE(
    (SELECT jsonb_agg(t.elem)
     FROM jsonb_array_elements(amc.agent_mode::jsonb->'tools') AS t(elem)
     WHERE NOT ({_DANGLING_PREDICATE})),
    '[]'::jsonb)
)::text
WHERE amc.id IN (SELECT app_model_config_id FROM apps
                 WHERE app_model_config_id IS NOT NULL)
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(amc.agent_mode::jsonb->'tools', '[]'::jsonb)) AS t(elem)
    WHERE {_DANGLING_PREDICATE});
"""


def _psql(sql: str) -> str:
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql a échoué : {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def is_applied() -> bool:
    try:
        return _psql(COUNT_SQL) == "0"
    except Exception as e:
        print(f"  is_applied: psql inaccessible ({e})", file=sys.stderr)
        return False


def run() -> None:
    dangling = _psql(LIST_SQL)
    if not dangling:
        print("  Aucune ref orpheline — rien à faire")
        return
    print("  Refs orphelines détectées :")
    for line in dangling.splitlines():
        print(f"    - {line}")
    out = _psql(UPDATE_SQL)
    print(f"  ✓ Purge effectuée ({out or 'UPDATE'})")
    remaining = _psql(COUNT_SQL)
    if remaining != "0":
        raise RuntimeError(f"{remaining} ref(s) orpheline(s) restante(s) après purge")
    print("  ✓ Plus aucune ref orpheline — les chats de l'app sont réparés")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
