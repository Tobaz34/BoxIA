"""AI Box — plugin audit : trace append-only (JSONL) de tous les tool calls.

Hook ``post_tool_call`` (observer). Enregistre qui/quoi/quand/durée/erreur et
flag les tools mutatifs. Local-only (RGPD/compliance) — port de app-audit.ts.

Commande ``/aibox-audit`` : résumé des derniers tool calls.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from . import audit_log

logger = logging.getLogger(__name__)

_DEFAULT_REGEX = r".*_create.*|.*create_.*|.*_update.*|.*_delete.*|.*_send.*|.*_pay.*|.*_refund.*|.*_cancel.*"


def _mut(tool_name: str) -> bool:
    return bool(tool_name) and re.compile(
        os.environ.get("AIBOX_MUTATING_TOOLS_REGEX", _DEFAULT_REGEX)
    ).fullmatch(tool_name) is not None


def _on_post_tool_call(
    tool_name: str = "",
    args: Any = None,
    result: Any = None,
    duration_ms: int = 0,
    session_id: str = "",
    task_id: str = "",
    **_: Any,
) -> None:
    try:
        rec = audit_log.build_record(
            tool_name, args, result, duration_ms, session_id or task_id, mutating=_mut(tool_name)
        )
        audit_log.append(rec)
    except Exception as e:  # best-effort, ne casse jamais l'agent
        logger.debug("aibox-audit: échec d'écriture: %s", e)


def _cmd_audit(raw_args: str = "") -> str:
    rows = audit_log.read_all()[-15:]
    if not rows:
        return "Aucune action auditée pour l'instant."
    lines = ["15 dernières actions :"]
    for r in rows:
        flag = "⚠️ " if r.get("mutating") else ""
        err = " [ERREUR]" if r.get("error") else ""
        lines.append(f"  {flag}{r.get('tool')}{err}  ({r.get('duration_ms')} ms)")
    return "\n".join(lines)


def register(ctx) -> None:
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_command(
        "aibox-audit", handler=_cmd_audit, description="Résumé des derniers tool calls audités."
    )
