"""AI Box — plugin RGPD : caviarde la PII française des résultats d'outils
avant qu'ils n'atteignent un LLM cloud.

Hook : ``transform_tool_result`` (réécrit la string résultat que voit le modèle).

Design « privacy by architecture » : le produit est local-first (Ollama par
défaut) → en usage normal la PII ne quitte jamais la machine. Ce plugin est
la défense-en-profondeur pour les déploiements cloud-primary (latence) : quand
``AIBOX_RGPD_SCRUB=1``, il caviarde SIRET/SIREN/NIR/IBAN/CB/téléphone/email des
sorties d'outils (le vrai vecteur d'exfiltration : données métier en masse
renvoyées par les connecteurs).

Pourquoi pas toujours actif : caviarder en mode local-first priverait le modèle
local de données légitimes (« quel est l'IBAN du client X ? »). Le scrub n'a de
sens que sur le chemin cloud → on le pilote par env.

Limite assumée (comme pii-scrub.ts) : best-effort, pas de NER (noms propres non
détectés). Couverture totale = rester local-first.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from . import pii_patterns

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return os.environ.get("AIBOX_RGPD_SCRUB", "").lower() in {"1", "true", "yes", "on"}


def _on_transform_tool_result(
    tool_name: str = "", result: Any = None, **_: Any
) -> Optional[str]:
    """Caviarde la PII de la string résultat. Retourner une string la remplace ;
    retourner None la laisse inchangée."""
    if not _enabled() or not isinstance(result, str) or not result:
        return None
    scrubbed, n, by_type = pii_patterns.scrub_pii(result)
    if n == 0:
        return None
    logger.info(
        "aibox-rgpd: %d donnée(s) personnelle(s) caviardée(s) sur le résultat de %s (%s)",
        n,
        tool_name or "?",
        by_type,
    )
    return scrubbed


def register(ctx) -> None:
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)
