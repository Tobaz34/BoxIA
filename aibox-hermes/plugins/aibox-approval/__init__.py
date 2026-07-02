"""AI Box — plugin approval-gate : confirmation NON CONTOURNABLE des tools mutatifs.

Hook ``pre_tool_call`` : tout tool dont le nom matche ``AIBOX_MUTATING_TOOLS_REGEX``
est bloqué tant qu'il n'a pas été approuvé via ``/aibox-approve <id>``.

Menace couverte : un email/PDF/page web piégé (prompt injection) peut pousser le
LLM à appeler un tool mutatif (créer une facture, envoyer un mail, supprimer…).
Le LLM ne peut PAS s'auto-approuver — seule une commande utilisateur débloque, et
seulement pour des arguments identiques (vérif par hash, cf. approval_store).

Commandes : ``/aibox-pending``, ``/aibox-approve <id>``, ``/aibox-reject <id>``.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

from . import approval_store as store

logger = logging.getLogger(__name__)

# Par défaut : verbes mutatifs courants (création/màj/suppression/envoi/paiement).
# Les tools lecture seule (list_*, get_*, read_*, *_health) ne matchent pas → non bloqués.
# On couvre 3 formes : verbe en début de nom (send_email, delete_file, pay_invoice),
# verbe préfixé par un underscore (mcp_x_create), et verbe suivi d'un underscore
# (create_invoice quelque part dans le nom). Détection insensible à la casse.
_VERBS = r"create|update|delete|send|pay|refund|cancel"
_DEFAULT_REGEX = (
    rf"^(?:{_VERBS})_.*"  # verbe en tête : send_email, delete_file, update_contact, pay_invoice
    rf"|.*_(?:{_VERBS}).*"  # verbe précédé d'un underscore : mcp_pennylane_create_invoice
    rf"|.*(?:{_VERBS})_.*"  # verbe suivi d'un underscore : xcreate_… / …create_…
)


def _pattern() -> "re.Pattern[str]":
    return re.compile(os.environ.get("AIBOX_MUTATING_TOOLS_REGEX", _DEFAULT_REGEX), re.IGNORECASE)


def _is_mutating(tool_name: str) -> bool:
    return bool(tool_name) and _pattern().fullmatch(tool_name) is not None


def _normalize_args(args: Any) -> Any:
    """Normalise les args pour le hash/résumé sans jamais les écraser en {}.

    Les args peuvent arriver en dict, mais aussi en string JSON (certains
    transports MCP) ou en liste. Si on les vidait en {} (ancien bug), l'invariant
    anti param-swap tombait : une approbation valait pour n'importe quels args.
    On tente donc un json.loads si c'est une string ; sinon on garde la valeur
    telle quelle (le hash porte sur la représentation canonique, cf. args_hash).
    """
    if isinstance(args, dict):
        return args
    if isinstance(args, str):
        try:
            return json.loads(args)
        except (ValueError, TypeError):
            return args  # string brute → hashée telle quelle
    if args is None:
        return {}
    return args  # liste / autre → hashée telle quelle


def _summarize_args(args: Any, max_val: int = 40, max_total: int = 240) -> str:
    """Résumé lisible des arguments pour que l'humain approuve en connaissance de cause."""
    def _trunc(v: Any) -> str:
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
        s = s.replace("\n", " ").strip()
        return s if len(s) <= max_val else s[: max_val - 1] + "…"

    if isinstance(args, dict):
        if not args:
            return "(aucun argument)"
        pairs = [f"{k}={_trunc(v)}" for k, v in args.items()]
        summary = ", ".join(pairs)
    else:
        summary = _trunc(args)
    if len(summary) > max_total:
        summary = summary[: max_total - 1] + "…"
    return summary


def _ttl_left(rec: dict) -> str:
    s = max(0, int(rec["expires_at"] - store.now()))
    return f"{s // 60} min {s % 60} s"


def _msg_created(rec: dict) -> str:
    return (
        f"🔒 Action sensible en attente de validation : « {rec['description']} ».\n"
        f"Pour l'autoriser, l'utilisateur doit envoyer : /aibox-approve {rec['id']} "
        f"(expire dans {_ttl_left(rec)}).\n"
        "Annonce-le clairement à l'utilisateur et n'exécute aucune autre action en attendant."
    )


def _msg_pending(rec: dict) -> str:
    return (
        f"⏳ L'action « {rec['description']} » est déjà en attente d'approbation "
        f"(id {rec['id']}). Attends /aibox-approve {rec['id']}."
    )


def _on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[dict]:
    if not _is_mutating(tool_name):
        return None
    sid = session_id or task_id or ""
    safe_args = _normalize_args(args)
    description = f"{tool_name} — {_summarize_args(safe_args)}"
    verdict, rec = store.evaluate(tool_name, safe_args, description=description, session_id=sid)
    if verdict == "allow":
        logger.info("aibox-approval: %s approuvé (id=%s) → exécution autorisée", tool_name, rec["id"])
        return None
    if verdict == "created":
        logger.info("aibox-approval: %s en attente (id=%s)", tool_name, rec["id"])
        return {"action": "block", "message": _msg_created(rec)}
    if verdict == "pending":
        return {"action": "block", "message": _msg_pending(rec)}
    return {"action": "block", "message": f"⛔ Action « {tool_name} » refusée par l'utilisateur."}


# --------------------------------------------------------------------------- #
# Slash commands
# --------------------------------------------------------------------------- #

def _cmd_pending(raw_args: str = "") -> str:
    recs = store.list_pending()
    if not recs:
        return "Aucune action en attente d'approbation."
    lines = ["Actions en attente :"]
    for r in recs:
        lines.append(f"  • {r['id']} — {r['description']}  (expire dans {_ttl_left(r)})")
    lines.append("\nApprouver : /aibox-approve <id>   ·   Refuser : /aibox-reject <id>")
    return "\n".join(lines)


def _cmd_approve(raw_args: str = "") -> str:
    parts = raw_args.strip().split()
    if not parts:
        return "Usage : /aibox-approve <id>"
    rec = store.decide(parts[0], True)
    if not rec:
        return f"Demande introuvable ou expirée : {parts[0]}"
    return f"✅ Approuvé : « {rec['description']} ». Redemande à l'assistant d'exécuter l'action."


def _cmd_reject(raw_args: str = "") -> str:
    parts = raw_args.strip().split()
    if not parts:
        return "Usage : /aibox-reject <id>"
    rec = store.decide(parts[0], False)
    if not rec:
        return f"Demande introuvable ou expirée : {parts[0]}"
    return f"⛔ Refusé : « {rec['description']} »."


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_command(
        "aibox-pending", handler=_cmd_pending,
        description="Liste les actions en attente d'approbation.",
    )
    ctx.register_command(
        "aibox-approve", handler=_cmd_approve,
        description="Approuve une action en attente : /aibox-approve <id>",
    )
    ctx.register_command(
        "aibox-reject", handler=_cmd_reject,
        description="Refuse une action en attente : /aibox-reject <id>",
    )
