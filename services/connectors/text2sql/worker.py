"""
Text-to-SQL — service HTTP consommable par Dify comme tool.

Workflow :
  1. Au démarrage : introspecte la DB (tables, colonnes, types) → schéma résumé
  2. /api/query reçoit une question en français + le schéma
  3. LLM génère une requête SQL (read-only, validée syntaxiquement)
  4. Exécute la requête (timeout 30s, LIMIT auto si manquant)
  5. Retourne résultat + SQL exécuté + explication en français

Sécurité :
  - Connexion DB en READ-ONLY (user dédié sans droits d'écriture)
  - LIMIT 100 forcé si absent
  - Liste blanche de keywords : SELECT, WITH, FROM, WHERE, GROUP BY, ORDER BY, LIMIT, JOIN
  - Aucun INSERT/UPDATE/DELETE/DROP/CREATE/TRUNCATE accepté (validation côté code)

Variables :
  DB_TYPE          postgres | mysql | mssql
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
  TOOL_API_KEY     Bearer token pour authentifier Dify→ce service
  TENANT_ID, OLLAMA_URL, LLM_MAIN
  ALLOWED_TABLES   ex: "customers,orders,products" (vide = tout autorisé)
"""
from __future__ import annotations

import logging
import os
import re
from typing import Annotated, Any

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

DB_TYPE = os.environ["DB_TYPE"].lower()
DB_HOST = os.environ["DB_HOST"]
DB_PORT = os.environ.get("DB_PORT", "")
DB_NAME = os.environ["DB_NAME"]
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
TOOL_API_KEY = os.environ["TOOL_API_KEY"]
ALLOWED_TABLES = {t.strip() for t in os.environ.get("ALLOWED_TABLES", "").split(",") if t.strip()}

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
LLM_MAIN = os.environ.get("LLM_MAIN", "qwen2.5:7b")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("text2sql")

DRIVERS = {
    "postgres": "postgresql+psycopg2",
    "mysql": "mysql+pymysql",
    "mssql": "mssql+pymssql",
}
DEFAULT_PORTS = {"postgres": 5432, "mysql": 3306, "mssql": 1433}


def make_engine() -> Engine:
    driver = DRIVERS[DB_TYPE]
    port = DB_PORT or DEFAULT_PORTS[DB_TYPE]
    url = f"{driver}://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{port}/{DB_NAME}"
    return create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 10})


engine = make_engine()


def schema_summary() -> str:
    """Résumé du schéma DB pour le prompt LLM."""
    insp = inspect(engine)
    out = []
    for t in insp.get_table_names():
        if ALLOWED_TABLES and t not in ALLOWED_TABLES:
            continue
        cols = insp.get_columns(t)
        cols_str = ", ".join(f"{c['name']} {c['type']}" for c in cols[:20])
        out.append(f"Table {t} ({cols_str})")
    return "\n".join(out)


SYSTEM_PROMPT = """Tu es un expert SQL pour la base {db_type}.
Schéma (résumé) :
{schema}

Règles strictes :
- Génère UNIQUEMENT une requête SELECT (lecture seule).
- Pas de INSERT, UPDATE, DELETE, DROP, CREATE, TRUNCATE.
- Toujours ajouter LIMIT 100 si la requête peut retourner beaucoup de lignes.
- Utilise des alias clairs et préfère les CTE (WITH) pour la lisibilité.
- Réponds en JSON : {{"sql": "...", "explanation": "..."}} (en français pour l'explication).
- Aucun texte hors du JSON.
"""

# ---- Validation SQL ----
DENY_PATTERNS = re.compile(
    r"\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|merge|exec|call)\b",
    re.IGNORECASE,
)


def validate_sql(sql: str) -> str:
    """Lève si la requête contient des mots-clés interdits ; ajoute LIMIT si manquant."""
    if DENY_PATTERNS.search(sql):
        raise HTTPException(400, f"Requête refusée (keywords écriture). SQL : {sql[:200]}")
    if not re.match(r"^\s*(with|select)\b", sql, re.IGNORECASE):
        raise HTTPException(400, f"Seules les requêtes SELECT/WITH sont autorisées. SQL : {sql[:200]}")
    if "limit" not in sql.lower() and DB_TYPE != "mssql":
        sql = sql.rstrip("; \n") + " LIMIT 100"
    return sql


# ---- App ----
app = FastAPI(title="AI Box — Text-to-SQL", version="0.1.0")


class QueryRequest(BaseModel):
    question: str


class QueryResponse(BaseModel):
    sql: str
    explanation: str
    rows: list[dict[str, Any]]
    row_count: int


def auth(authorization: str | None) -> None:
    if not authorization or authorization.removeprefix("Bearer ").strip() != TOOL_API_KEY:
        raise HTTPException(401, "Auth required")


@app.get("/healthz")
def healthz() -> dict:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"ok": True, "db_type": DB_TYPE}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/schema")
def get_schema(authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    return {"summary": schema_summary()}


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest, authorization: Annotated[str | None, Header()] = None) -> QueryResponse:
    auth(authorization)
    schema = schema_summary()
    prompt = SYSTEM_PROMPT.format(db_type=DB_TYPE, schema=schema)

    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN,
            "system": prompt,
            "prompt": req.question,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.0},
        })
        r.raise_for_status()
        import json as _json
        gen = _json.loads(r.json()["response"])

    sql = validate_sql(gen.get("sql", "").strip())
    explanation = gen.get("explanation", "")

    with engine.connect() as conn:
        result = conn.execute(text(sql))
        rows = [dict(r._mapping) for r in result]

    return QueryResponse(sql=sql, explanation=explanation, rows=rows, row_count=len(rows))
