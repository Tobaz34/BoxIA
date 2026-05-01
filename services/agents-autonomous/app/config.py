"""Configuration centrale lue depuis les variables d'environnement.

Une seule source de vérité, validée Pydantic. Tout le reste de l'app importe
`settings` depuis ici — pas d'os.getenv dispersé.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ---- Profil hardware ----
    hw_profile: Literal["tpe", "pme", "pme-plus"] = Field("tpe", alias="HW_PROFILE")

    # ---- Backend inférence ----
    inference_backend: Literal["ollama", "vllm"] = Field("ollama", alias="INFERENCE_BACKEND")
    ollama_url: str = Field("http://ollama:11434", alias="OLLAMA_URL")
    vllm_url: str = Field("http://vllm:8000", alias="VLLM_URL")
    llm_main: str = Field("qwen2.5:7b", alias="LLM_MAIN")
    llm_temperature: float = Field(0.2, alias="LLM_TEMPERATURE")
    llm_timeout_seconds: int = Field(90, alias="LLM_TIMEOUT_SECONDS")

    # ---- LangGraph ----
    postgres_url: str | None = Field(None, alias="POSTGRES_URL")
    max_steps_per_graph: int = Field(12, alias="MAX_STEPS_PER_GRAPH")

    # ---- Sécurité ----
    agents_api_key: str = Field(..., alias="AGENTS_API_KEY")

    # ---- Comportement ----
    enable_outlines: bool = Field(False, alias="ENABLE_OUTLINES")
    log_level: str = Field("INFO", alias="LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    """Singleton (cache process-wide)."""
    return Settings()  # type: ignore[call-arg]
