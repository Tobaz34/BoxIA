"""Abstraction backend LLM : Ollama (tier tpe) ou vLLM (tier pme/+).

Choix au démarrage selon `INFERENCE_BACKEND`. Une fois construit, les graphs
LangGraph manipulent un `BaseChatModel` standard, ils ignorent le backend.

Pour le structured output :
- Si vLLM : on passe `extra_body={"guided_json": schema}` → JSON 100% conforme
- Si Ollama : on passe `format="json"` (best-effort, le LLM peut diverger)
- Dans les deux cas, on parse + valide via Pydantic, retry au besoin.
"""
from __future__ import annotations

import json
import logging
from typing import Any, TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, ValidationError

from app.config import get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


def get_chat_model(temperature: float | None = None) -> BaseChatModel:
    """Renvoie un BaseChatModel selon le backend configuré.

    Pour Ollama : ChatOllama natif.
    Pour vLLM : ChatOpenAI pointé vers l'endpoint vLLM (API OpenAI-compatible).

    Le caller ne devrait JAMAIS construire de chat model directement.
    """
    s = get_settings()
    temp = temperature if temperature is not None else s.llm_temperature

    if s.inference_backend == "vllm":
        return ChatOpenAI(
            base_url=f"{s.vllm_url}/v1",
            api_key="not-needed",
            model=s.llm_main,
            temperature=temp,
            timeout=s.llm_timeout_seconds,
            max_retries=2,
        )

    return ChatOllama(
        base_url=s.ollama_url,
        model=s.llm_main,
        temperature=temp,
        timeout=s.llm_timeout_seconds,
        num_ctx=8192,
    )


async def structured_invoke(
    messages: list[BaseMessage],
    schema_cls: type[T],
    temperature: float | None = None,
    max_retries: int = 2,
) -> T:
    """Invoque le LLM en exigeant une sortie JSON conforme à `schema_cls`.

    Stratégie :
    1. vLLM + ENABLE_OUTLINES → guided_json côté serveur (zéro échec parsing)
    2. Ollama → format=json (best-effort) + retry avec correction si parse fail
    3. Validation Pydantic finale dans tous les cas

    Lève ValidationError si max_retries dépassé.
    """
    s = get_settings()
    schema = schema_cls.model_json_schema()
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        if s.inference_backend == "vllm" and s.enable_outlines:
            llm = ChatOpenAI(
                base_url=f"{s.vllm_url}/v1",
                api_key="not-needed",
                model=s.llm_main,
                temperature=temperature if temperature is not None else s.llm_temperature,
                timeout=s.llm_timeout_seconds,
                model_kwargs={"extra_body": {"guided_json": schema}},
            )
        else:
            llm = ChatOllama(
                base_url=s.ollama_url,
                model=s.llm_main,
                temperature=temperature if temperature is not None else s.llm_temperature,
                timeout=s.llm_timeout_seconds,
                format="json",
            )

        try:
            response = await llm.ainvoke(messages)
            content = response.content if isinstance(response.content, str) else str(response.content)
            data = json.loads(content)
            return schema_cls.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as e:
            last_error = e
            logger.warning(
                "structured_invoke parse fail (attempt %d/%d): %s",
                attempt + 1, max_retries + 1, e,
            )
            if attempt < max_retries:
                # Ajoute un message correctif pour la prochaine tentative
                from langchain_core.messages import SystemMessage
                messages = list(messages) + [
                    SystemMessage(
                        content=(
                            "La réponse précédente n'était pas un JSON valide ou ne respectait "
                            f"pas le schéma. Erreur : {e}. Réponds UNIQUEMENT avec du JSON conforme."
                        )
                    )
                ]
            continue

    assert last_error is not None
    raise last_error


def get_backend_info() -> dict[str, Any]:
    """Pour /healthz et /v1/info — diagnostic backend en cours."""
    s = get_settings()
    return {
        "backend": s.inference_backend,
        "model": s.llm_main,
        "url": s.vllm_url if s.inference_backend == "vllm" else s.ollama_url,
        "outlines_enabled": s.enable_outlines and s.inference_backend == "vllm",
        "hw_profile": s.hw_profile,
    }
