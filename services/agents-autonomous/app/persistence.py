"""Checkpointer LangGraph — persistance des workflows long-running.

3 modes :
- `disabled` (défaut tier tpe) : pas de checkpoint. Workflow stateless.
- `memory` : checkpoint en RAM (utile pour tests, perd à chaque restart).
- `postgres` : checkpoint dans Postgres (Dify DB par défaut, schéma `langgraph`).

Usage côté graph :
    from app.persistence import get_checkpointer

    cp = await get_checkpointer()  # None si disabled
    graph = builder.compile(checkpointer=cp)

Côté API :
    config = {"configurable": {"thread_id": "tenant-foo/workflow-bar/run-baz"}}
    result = await graph.ainvoke(state, config=config)

Le `thread_id` permet de reprendre un workflow à mi-chemin :
- Si l'execution crash, on relance avec le même thread_id → reprise au dernier checkpoint
- Si l'utilisateur clique "valider" sur une étape humaine → on relance avec le même thread_id

Pour le tier tpe (workflow rapide ~5-25s), checkpointer désactivé par défaut
(latence négligeable de toute façon). Pour pme/pme-plus, on l'active pour
permettre les workflows de plusieurs minutes (rapprochement multi-factures,
onboarding client).
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal

from app.config import get_settings

logger = logging.getLogger(__name__)

CheckpointerMode = Literal["disabled", "memory", "postgres"]


def _resolve_mode() -> CheckpointerMode:
    """Détermine le mode depuis les env vars (avec auto-détection raisonnable)."""
    explicit = os.environ.get("CHECKPOINTER_MODE", "").lower()
    if explicit in {"disabled", "memory", "postgres"}:
        return explicit  # type: ignore[return-value]

    # Auto : si POSTGRES_URL fourni, postgres ; sinon disabled
    s = get_settings()
    if s.postgres_url:
        return "postgres"
    return "disabled"


# Singleton process-wide (le checkpointer Postgres maintient un pool de connections).
_CHECKPOINTER = None
_MODE: CheckpointerMode | None = None


@asynccontextmanager
async def lifespan_checkpointer() -> AsyncIterator[None]:
    """Init au boot, cleanup au shutdown. À utiliser depuis FastAPI lifespan."""
    global _CHECKPOINTER, _MODE

    _MODE = _resolve_mode()
    logger.info("checkpointer_mode=%s", _MODE)

    if _MODE == "memory":
        from langgraph.checkpoint.memory import MemorySaver
        _CHECKPOINTER = MemorySaver()

    elif _MODE == "postgres":
        try:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        except ImportError as e:
            logger.error("langgraph-checkpoint-postgres non installé: %s", e)
            _MODE = "disabled"
            _CHECKPOINTER = None
            yield
            return

        s = get_settings()
        # `from_conn_string` retourne un async context manager
        # → on l'entre une fois pour la durée du process
        cp_cm = AsyncPostgresSaver.from_conn_string(s.postgres_url)
        _CHECKPOINTER = await cp_cm.__aenter__()
        try:
            await _CHECKPOINTER.setup()  # crée les tables si absentes
            logger.info("postgres_checkpointer_ready")
        except Exception as e:
            logger.error("postgres_checkpointer_setup_failed: %s — fallback disabled", e)
            await cp_cm.__aexit__(None, None, None)
            _CHECKPOINTER = None
            _MODE = "disabled"
            yield
            return

        try:
            yield
        finally:
            await cp_cm.__aexit__(None, None, None)
            _CHECKPOINTER = None
            logger.info("postgres_checkpointer_closed")
        return

    yield


def get_checkpointer():
    """Renvoie l'instance partagée (ou None si disabled).

    À appeler dans le graph builder UNE fois après le boot. Si le checkpointer
    change de mode (rare), il faut redémarrer le service.
    """
    return _CHECKPOINTER


def get_mode() -> str:
    return _MODE or "disabled"
