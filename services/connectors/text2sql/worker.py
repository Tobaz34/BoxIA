"""Text-to-SQL — service HTTP consommable par Dify comme tool.

Workflow :
  1. Au démarrage : introspecte la DB (tables, colonnes, types) → schéma résumé
  2. /v1/query reçoit une question en français
  3. Récupération RAG des golden examples Q→SQL pertinents (Qdrant)
  4. LLM génère une requête SQL (qwen2.5-coder recommandé)
  5. Validation syntaxique + EXPLAIN safety check (refuse si cost > seuil)
  6. Exécute la requête (timeout, LIMIT auto)
  7. Si erreur SQL → 1 retry avec correction (l'erreur PG est renvoyée au LLM)
  8. Retourne résultat + SQL exécuté + explication française

Endpoints :
  GET  /healthz
  GET  /v1/info
  GET  /v1/schema
  POST /v1/query                    {question}
  POST /v1/golden                    {question, sql, explanation?}    (ajouter exemple)
  GET  /v1/golden                    (liste examples)
  DELETE /v1/golden/{id}

Sécurité :
  - Connexion DB en READ-ONLY (user dédié sans droits d'écriture)
  - LIMIT 100 forcé si absent
  - Liste deny : INSERT/UPDATE/DELETE/DROP/CREATE/TRUNCATE/etc.
  - EXPLAIN avant exécution → refuse si estimated cost > MAX_COST
  - Timeout requête forcé via SET LOCAL

Variables :
  DB_TYPE          postgres | mysql | mssql
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
  TOOL_API_KEY     Bearer token
  TENANT_ID        nom collection Qdrant des golden examples
  OLLAMA_URL, LLM_MAIN, LLM_EMBED
  ALLOWED_TABLES   ex: "customers,orders" (vide = tout)
  MAX_COST         défaut: 1e6 (PostgreSQL EXPLAIN cost)
  STATEMENT_TIMEOUT_MS  défaut: 30000
  QDRANT_URL, QDRANT_API_KEY
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

DB_TYPE = os.environ["DB_TYPE"].lower()
DB_HOST = os.environ["DB_HOST"]
DB_PORT = os.environ.get("DB_PORT", "")
DB_NAME = os.environ["DB_NAME"]
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
TOOL_API_KEY = os.environ["TOOL_API_KEY"]
TENANT_ID = os.environ.get("TENANT_ID", "default")
ALLOWED_TABLES = {t.strip() for t in os.environ.get("ALLOWED_TABLES", "").split(",") if t.strip()}

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
LLM_MAIN = os.environ.get("LLM_MAIN", "qwen2.5-coder:7b")
LLM_EMBED = os.environ.get("LLM_EMBED", "bge-m3")

MAX_COST = float(os.environ.get("MAX_COST", "1e6"))
STATEMENT_TIMEOUT_MS = int(os.environ.get("STATEMENT_TIMEOUT_MS", "30000"))
MAX_ROWS = int(os.environ.get("MAX_ROWS", "100"))

QDRANT_URL = os.environ.get("QDRANT_URL", "http://aibox-qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")

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


# ===========================================================================
# Schéma DB pour le prompt
# ===========================================================================

def schema_summary() -> str:
    insp = inspect(engine)
    out = []
    for t in insp.get_table_names():
        if ALLOWED_TABLES and t not in ALLOWED_TABLES:
            continue
        cols = insp.get_columns(t)
        cols_str = ", ".join(f"{c['name']} {c['type']}" for c in cols[:25])
        out.append(f"Table {t} ({cols_str})")
    return "\n".join(out)


# ===========================================================================
# Golden examples (RAG via Qdrant)
# ===========================================================================
# Pattern Vanna : on indexe des paires Q→SQL "validées" du tenant et on
# retrouve les top-K à chaque requête pour few-shot le LLM.

GOLDEN_COLLECTION = f"t2sql_{TENANT_ID}"
EMBEDDING_DIM = 1024  # bge-m3


def _qdrant_client():
    """Lazy import : qdrant-client reste optionnel."""
    from qdrant_client import QdrantClient
    return QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY or None, timeout=10)


def _ensure_golden_collection():
    try:
        from qdrant_client.http import models as qdr
        qd = _qdrant_client()
        if not qd.collection_exists(GOLDEN_COLLECTION):
            qd.create_collection(
                collection_name=GOLDEN_COLLECTION,
                vectors_config=qdr.VectorParams(size=EMBEDDING_DIM, distance=qdr.Distance.COSINE),
            )
            log.info("Created golden collection %s", GOLDEN_COLLECTION)
    except Exception as e:
        log.warning("Qdrant golden collection init failed: %s — RAG désactivé", e)


def _embed(text: str) -> list[float]:
    with httpx.Client(base_url=OLLAMA_URL, timeout=30.0) as c:
        r = c.post("/api/embeddings", json={"model": LLM_EMBED, "prompt": text})
        r.raise_for_status()
        return r.json()["embedding"]


def _retrieve_examples(question: str, k: int = 5) -> list[dict]:
    """Top-K paires Q/SQL pertinentes depuis Qdrant. Renvoie [] si Qdrant down."""
    try:
        emb = _embed(question)
        qd = _qdrant_client()
        hits = qd.search(collection_name=GOLDEN_COLLECTION, query_vector=emb, limit=k)
        return [{"q": h.payload.get("q"), "sql": h.payload.get("sql"), "score": h.score} for h in hits]
    except Exception as e:
        log.warning("Golden examples retrieval failed: %s", e)
        return []


def _add_golden(q: str, sql: str, explanation: str = "") -> str:
    import uuid
    from qdrant_client.http import models as qdr
    qd = _qdrant_client()
    point_id = str(uuid.uuid4())
    qd.upsert(
        collection_name=GOLDEN_COLLECTION,
        points=[qdr.PointStruct(
            id=point_id, vector=_embed(q),
            payload={"q": q, "sql": sql, "explanation": explanation},
        )],
    )
    return point_id


# ===========================================================================
# Prompt
# ===========================================================================

def build_prompt(schema: str, examples: list[dict]) -> str:
    examples_str = ""
    if examples:
        examples_str = "\n\nExemples de requêtes validées (à utiliser comme référence) :\n"
        for ex in examples:
            examples_str += f'\n- Question : "{ex["q"]}"\n  SQL : {ex["sql"]}\n'

    return f"""Tu es un expert SQL pour la base {DB_TYPE}.

Schéma (résumé) :
{schema}
{examples_str}

Règles strictes :
- Génère UNIQUEMENT une requête SELECT (lecture seule).
- Pas de INSERT, UPDATE, DELETE, DROP, CREATE, TRUNCATE.
- Toujours ajouter LIMIT {MAX_ROWS} si la requête peut retourner beaucoup de lignes.
- Utilise des alias clairs et préfère les CTE (WITH) pour la lisibilité.
- Réponds en JSON STRICT : {{"sql": "...", "explanation": "..."}} (en français pour l'explication).
- Aucun texte hors du JSON.
"""


# ===========================================================================
# Validation SQL + EXPLAIN safety
# ===========================================================================

DENY_PATTERNS = re.compile(
    r"\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|merge|exec|call|copy|vacuum)\b",
    re.IGNORECASE,
)


def validate_sql(sql: str) -> str:
    if DENY_PATTERNS.search(sql):
        raise HTTPException(400, f"Requête refusée (keywords écriture). SQL : {sql[:200]}")
    if not re.match(r"^\s*(with|select)\b", sql, re.IGNORECASE):
        raise HTTPException(400, f"Seules les requêtes SELECT/WITH sont autorisées. SQL : {sql[:200]}")
    if "limit" not in sql.lower() and DB_TYPE != "mssql":
        sql = sql.rstrip("; \n") + f" LIMIT {MAX_ROWS}"
    return sql


def explain_safety_check(sql: str) -> dict:
    """Lance un EXPLAIN (FORMAT JSON) et lève si le coût estimé est aberrant.
    Postgres uniquement (MySQL/MSSQL retournent un format différent — ignoré pour l'instant).
    """
    if DB_TYPE != "postgres":
        return {"skipped": True}
    try:
        with engine.connect() as conn:
            res = conn.execute(text(f"EXPLAIN (FORMAT JSON) {sql}"))
            row = res.fetchone()
            plan = row[0] if row else None
            cost = None
            if plan and isinstance(plan, list) and plan:
                cost = plan[0].get("Plan", {}).get("Total Cost")
            elif plan and isinstance(plan, dict):
                cost = plan.get("Plan", {}).get("Total Cost")
            if cost is not None and cost > MAX_COST:
                raise HTTPException(
                    400,
                    f"Requête refusée : coût estimé {cost:.0f} > seuil {MAX_COST:.0f}. "
                    f"Reformule la question ou ajoute des filtres.",
                )
            return {"cost_estimated": cost, "plan_summary": str(plan)[:500]}
    except HTTPException:
        raise
    except Exception as e:
        log.warning("EXPLAIN failed (skip safety check): %s", e)
        return {"explain_error": str(e)}


# ===========================================================================
# App
# ===========================================================================

app = FastAPI(title="AI Box — Text-to-SQL", version="0.2.0")


@app.on_event("startup")
def startup():
    _ensure_golden_collection()


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=1000)


class QueryResponse(BaseModel):
    sql: str
    explanation: str
    rows: list[dict[str, Any]]
    row_count: int
    cost_estimated: float | None = None
    examples_used: int = 0
    retries: int = 0


def auth(authorization: str | None) -> None:
    if not authorization or authorization.removeprefix("Bearer ").strip() != TOOL_API_KEY:
        raise HTTPException(401, "Auth required")


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return "OK"
    except Exception as e:
        raise HTTPException(503, f"DB error: {e}")


@app.get("/v1/info")
def info() -> dict:
    return {
        "service": "aibox-text2sql",
        "version": "0.2.0",
        "db_type": DB_TYPE,
        "tenant": TENANT_ID,
        "model": LLM_MAIN,
        "embed_model": LLM_EMBED,
        "max_cost": MAX_COST,
        "max_rows": MAX_ROWS,
        "qdrant_url": QDRANT_URL,
    }


@app.get("/v1/schema")
def get_schema(authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    return {"summary": schema_summary()}


def _llm_generate(prompt: str, question: str) -> dict:
    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN,
            "system": prompt,
            "prompt": question,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.0},
        })
        r.raise_for_status()
        return json.loads(r.json()["response"])


@app.post("/v1/query", response_model=QueryResponse)
def query(req: QueryRequest, authorization: Annotated[str | None, Header()] = None) -> QueryResponse:
    auth(authorization)
    schema = schema_summary()
    examples = _retrieve_examples(req.question, k=5)
    prompt = build_prompt(schema, examples)
    started = time.time()

    retries = 0
    last_error: str | None = None
    sql = ""
    explanation = ""

    for attempt in range(2):  # max 1 retry
        gen = _llm_generate(prompt + (f"\n\nLa requête précédente a échoué : {last_error}\nCorrige." if last_error else ""), req.question)
        sql = validate_sql(gen.get("sql", "").strip().rstrip(";"))
        explanation = gen.get("explanation", "")
        try:
            safety = explain_safety_check(sql)
            with engine.connect() as conn:
                if DB_TYPE == "postgres":
                    conn.execute(text(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"))
                result = conn.execute(text(sql))
                rows = [dict(r._mapping) for r in result]
            log.info("query OK (attempt=%d, ms=%d, rows=%d)", attempt + 1, int((time.time() - started) * 1000), len(rows))
            return QueryResponse(
                sql=sql, explanation=explanation, rows=rows, row_count=len(rows),
                cost_estimated=safety.get("cost_estimated") if isinstance(safety, dict) else None,
                examples_used=len(examples), retries=retries,
            )
        except HTTPException:
            raise
        except Exception as e:
            last_error = str(e)[:300]
            retries += 1
            log.warning("SQL execute failed (attempt=%d): %s", attempt + 1, last_error)

    raise HTTPException(500, f"SQL execution failed after retries: {last_error}")


# ===========================================================================
# Golden examples API
# ===========================================================================

class GoldenExample(BaseModel):
    question: str = Field(..., min_length=5)
    sql: str = Field(..., min_length=10)
    explanation: str = ""


@app.post("/v1/golden")
def add_golden(ex: GoldenExample, authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    sql = validate_sql(ex.sql.strip().rstrip(";"))
    point_id = _add_golden(ex.question, sql, ex.explanation)
    return {"id": point_id, "added": True}


@app.get("/v1/golden")
def list_golden(authorization: Annotated[str | None, Header()] = None) -> list[dict]:
    auth(authorization)
    try:
        qd = _qdrant_client()
        # Scroll (pas de search → toutes les entries)
        from qdrant_client.http import models as qdr
        out = []
        offset = None
        while True:
            res = qd.scroll(collection_name=GOLDEN_COLLECTION, limit=100, offset=offset, with_payload=True)
            for p in res[0]:
                out.append({"id": str(p.id), "q": p.payload.get("q"), "sql": p.payload.get("sql")})
            offset = res[1]
            if offset is None:
                break
        return out
    except Exception as e:
        return [{"error": str(e)}]


@app.delete("/v1/golden/{point_id}")
def delete_golden(point_id: str, authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    try:
        qd = _qdrant_client()
        qd.delete(collection_name=GOLDEN_COLLECTION, points_selector=[point_id])
        return {"deleted": point_id}
    except Exception as e:
        raise HTTPException(500, str(e))
