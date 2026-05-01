"""FastAPI : mémoire long-terme par user/agent, backed by Qdrant.

Endpoints :
- POST /memory/add               → extrait faits depuis dialogue + embed + upsert
- GET  /memory/search            → top-K facts pertinents pour un contexte donné
- DELETE /memory/user/{user_id}  → wipe RGPD complet d'un user
- GET  /healthz, /v1/info

Auth : Bearer MEM0_API_KEY.

Architecture interne :
- 1 collection Qdrant par tenant : `mem0_<TENANT>`
- Chaque mémoire = {user_id, agent_id, fact, source_text, created_at}
- Embeddings via Ollama bge-m3 (1024 dims)
- Extraction des faits via Ollama LLM (qwen2.5:7b par défaut)
"""
from __future__ import annotations

import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import httpx
import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from qdrant_client import QdrantClient
from qdrant_client.http import models as qdr
from tenacity import retry, stop_after_attempt, wait_exponential

from app import __version__


# ===========================================================================
# Settings
# ===========================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    qdrant_url: str = Field("http://aibox-qdrant:6333", alias="QDRANT_URL")
    qdrant_api_key: str = Field("", alias="QDRANT_API_KEY")

    ollama_url: str = Field("http://ollama:11434", alias="OLLAMA_URL")
    llm_embed: str = Field("bge-m3", alias="LLM_EMBED")
    llm_main: str = Field("qwen2.5:7b", alias="LLM_MAIN")

    tenant_id: str = Field("default", alias="TENANT_ID")
    mem0_api_key: str = Field(..., alias="MEM0_API_KEY")
    log_level: str = Field("INFO", alias="LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


# ===========================================================================
# Schemas API
# ===========================================================================

class AddMemoryRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=200)
    agent_id: str = Field("default", description="Pour cloisonner par agent")
    messages: list[dict] = Field(
        ...,
        description="[{role: user|assistant, content: ...}, ...]",
        min_length=1,
    )
    metadata: dict = Field(default_factory=dict)


class MemoryFact(BaseModel):
    id: str
    user_id: str
    agent_id: str
    fact: str
    source_text: str
    created_at: str
    score: float | None = None
    metadata: dict = Field(default_factory=dict)


class AddMemoryResponse(BaseModel):
    facts_added: int
    facts: list[MemoryFact]


class SearchMemoryResponse(BaseModel):
    facts: list[MemoryFact]
    query: str


# ===========================================================================
# Logging
# ===========================================================================

def _setup_logging():
    s = get_settings()
    level = getattr(logging, s.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, stream=sys.stdout, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
    )


# ===========================================================================
# Qdrant + Ollama clients
# ===========================================================================

EMBEDDING_DIM = 1024  # bge-m3
COLLECTION_PREFIX = "mem0_"


def collection_name() -> str:
    s = get_settings()
    # Sanitize : Qdrant n'accepte pas tous les caractères dans les noms
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in s.tenant_id)
    return f"{COLLECTION_PREFIX}{safe}"


def get_qdrant() -> QdrantClient:
    s = get_settings()
    return QdrantClient(
        url=s.qdrant_url,
        api_key=s.qdrant_api_key or None,
        prefer_grpc=False,
        timeout=10,
    )


def ensure_collection():
    """Crée la collection si absente, idempotent."""
    qd = get_qdrant()
    name = collection_name()
    if not qd.collection_exists(name):
        qd.create_collection(
            collection_name=name,
            vectors_config=qdr.VectorParams(size=EMBEDDING_DIM, distance=qdr.Distance.COSINE),
        )
        # Index sur user_id pour filtrer rapidement
        qd.create_payload_index(
            collection_name=name,
            field_name="user_id",
            field_schema=qdr.PayloadSchemaType.KEYWORD,
        )
        qd.create_payload_index(
            collection_name=name,
            field_name="agent_id",
            field_schema=qdr.PayloadSchemaType.KEYWORD,
        )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=8))
async def ollama_embed(text: str) -> list[float]:
    s = get_settings()
    async with httpx.AsyncClient(base_url=s.ollama_url, timeout=60.0) as c:
        r = await c.post("/api/embeddings", json={"model": s.llm_embed, "prompt": text})
        r.raise_for_status()
        return r.json()["embedding"]


@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=1, max=10))
async def ollama_extract_facts(messages: list[dict]) -> list[str]:
    """Demande au LLM d'extraire les faits durables du dialogue.

    Retourne une liste de phrases factuelles courtes (1 fait = 1 phrase).
    """
    s = get_settings()
    convo = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages)
    system = (
        "Tu es un extracteur de faits durables depuis une conversation. "
        "Extrait UNIQUEMENT les informations factuelles utiles à long terme : "
        "préférences utilisateur, contexte personnel/professionnel, projets en cours, "
        "décisions prises. IGNORE les questions, les hésitations, le bavardage. "
        "Réponds UNIQUEMENT avec un JSON : "
        '{"facts": ["fait 1 en 1 phrase", "fait 2", ...]}. '
        "Si aucun fait durable, retourne {\"facts\": []}."
    )
    async with httpx.AsyncClient(base_url=s.ollama_url, timeout=120.0) as c:
        r = await c.post("/api/generate", json={
            "model": s.llm_main,
            "system": system,
            "prompt": f"Conversation à analyser :\n\n{convo}\n\nExtrait les faits.",
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.1},
        })
        r.raise_for_status()
        import json as _json
        data = _json.loads(r.json()["response"])
        facts = data.get("facts", [])
        if not isinstance(facts, list):
            return []
        return [str(f).strip() for f in facts if str(f).strip()]


# ===========================================================================
# Auth
# ===========================================================================

bearer = HTTPBearer(auto_error=False)


def require_api_key(creds: HTTPAuthorizationCredentials | None = Depends(bearer)):
    s = get_settings()
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != s.mem0_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key invalide ou manquante",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ===========================================================================
# App
# ===========================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    _setup_logging()
    log = structlog.get_logger("aibox.memory")
    s = get_settings()
    try:
        ensure_collection()
        log.info("memory_service_started", tenant=s.tenant_id, collection=collection_name())
    except Exception as e:
        log.error("memory_init_failed", error=str(e))
    yield
    log.info("memory_service_stopping")


app = FastAPI(
    title="AI Box — Memory",
    version=__version__,
    lifespan=lifespan,
)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/v1/info")
async def info():
    s = get_settings()
    return {
        "service": "aibox-memory",
        "version": __version__,
        "tenant": s.tenant_id,
        "collection": collection_name(),
        "qdrant_url": s.qdrant_url,
        "ollama_url": s.ollama_url,
        "llm_embed": s.llm_embed,
        "llm_main": s.llm_main,
    }


@app.post(
    "/memory/add",
    response_model=AddMemoryResponse,
    dependencies=[Depends(require_api_key)],
)
async def add_memory(req: AddMemoryRequest):
    log = structlog.get_logger("aibox.memory")
    started = time.time()

    facts = await ollama_extract_facts(req.messages)
    if not facts:
        return AddMemoryResponse(facts_added=0, facts=[])

    qd = get_qdrant()
    name = collection_name()
    source = "\n".join(f"{m['role']}: {m['content']}" for m in req.messages)[:2000]

    points: list[qdr.PointStruct] = []
    facts_out: list[MemoryFact] = []
    for fact in facts[:20]:  # cap raisonnable
        embedding = await ollama_embed(fact)
        fact_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "user_id": req.user_id,
            "agent_id": req.agent_id,
            "fact": fact,
            "source_text": source,
            "created_at": now,
            **req.metadata,
        }
        points.append(qdr.PointStruct(id=fact_id, vector=embedding, payload=payload))
        facts_out.append(MemoryFact(
            id=fact_id,
            user_id=req.user_id,
            agent_id=req.agent_id,
            fact=fact,
            source_text=source,
            created_at=now,
            metadata=req.metadata,
        ))

    qd.upsert(collection_name=name, points=points)

    log.info(
        "memory_added",
        user_id=req.user_id,
        agent_id=req.agent_id,
        facts_count=len(points),
        duration_ms=int((time.time() - started) * 1000),
    )
    return AddMemoryResponse(facts_added=len(points), facts=facts_out)


@app.get(
    "/memory/search",
    response_model=SearchMemoryResponse,
    dependencies=[Depends(require_api_key)],
)
async def search_memory(
    user_id: str,
    query: str,
    agent_id: str | None = None,
    limit: int = 5,
):
    if limit < 1 or limit > 50:
        raise HTTPException(400, "limit must be between 1 and 50")

    embedding = await ollama_embed(query)
    qd = get_qdrant()
    name = collection_name()

    must = [qdr.FieldCondition(key="user_id", match=qdr.MatchValue(value=user_id))]
    if agent_id:
        must.append(qdr.FieldCondition(key="agent_id", match=qdr.MatchValue(value=agent_id)))

    results = qd.search(
        collection_name=name,
        query_vector=embedding,
        query_filter=qdr.Filter(must=must),
        limit=limit,
    )

    facts = [
        MemoryFact(
            id=str(p.id),
            user_id=p.payload["user_id"],
            agent_id=p.payload.get("agent_id", "default"),
            fact=p.payload["fact"],
            source_text=p.payload.get("source_text", ""),
            created_at=p.payload.get("created_at", ""),
            score=p.score,
            metadata={k: v for k, v in p.payload.items() if k not in {"user_id", "agent_id", "fact", "source_text", "created_at"}},
        )
        for p in results
    ]
    return SearchMemoryResponse(facts=facts, query=query)


@app.delete(
    "/memory/user/{user_id}",
    dependencies=[Depends(require_api_key)],
    summary="RGPD : suppression de toute la mémoire d'un user",
)
async def delete_user_memory(user_id: str):
    log = structlog.get_logger("aibox.memory")
    qd = get_qdrant()
    name = collection_name()

    # Compter avant pour le rapport
    count_resp = qd.count(
        collection_name=name,
        count_filter=qdr.Filter(
            must=[qdr.FieldCondition(key="user_id", match=qdr.MatchValue(value=user_id))]
        ),
    )

    qd.delete(
        collection_name=name,
        points_selector=qdr.FilterSelector(
            filter=qdr.Filter(
                must=[qdr.FieldCondition(key="user_id", match=qdr.MatchValue(value=user_id))]
            )
        ),
    )
    log.info("memory_user_deleted", user_id=user_id, facts_count=count_resp.count)
    return {"user_id": user_id, "facts_deleted": count_resp.count}
