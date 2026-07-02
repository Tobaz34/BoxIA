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


def _scrub_recursive(value: Any) -> tuple[Any, int, dict]:
    """Caviarde récursivement toutes les strings d'une structure dict/list/str.

    Les résultats d'outils structurés (dict/list — ex : sortie MCP Pennylane avec
    emails/SIREN) partaient au cloud SANS scrub quand on n'acceptait que les str.
    On parcourt donc la structure et on caviarde chaque valeur string.
    """
    by_type: dict[str, int] = {}

    def _merge(sub: dict) -> None:
        for k, v in sub.items():
            by_type[k] = by_type.get(k, 0) + v

    if isinstance(value, str):
        out, n, by = pii_patterns.scrub_pii(value)
        return out, n, by
    if isinstance(value, dict):
        new: dict = {}
        for k, v in value.items():
            nv, _, by = _scrub_recursive(v)
            _merge(by)
            new[k] = nv
        return new, sum(by_type.values()), by_type
    if isinstance(value, (list, tuple)):
        seq = [ _scrub_recursive(v) for v in value ]
        for _, _, by in seq:
            _merge(by)
        rebuilt = [ nv for nv, _, _ in seq ]
        return (type(value)(rebuilt), sum(by_type.values()), by_type)
    return value, 0, {}


def _on_transform_tool_result(
    tool_name: str = "", result: Any = None, **_: Any
) -> Optional[Any]:
    """Caviarde la PII du résultat. Retourner une valeur la remplace ; retourner
    None la laisse inchangée. Gère les str ET les structures dict/list."""
    if not _enabled() or result is None:
        return None
    if not isinstance(result, (str, dict, list, tuple)):
        return None
    if isinstance(result, str) and not result:
        return None
    scrubbed, n, by_type = _scrub_recursive(result)
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
