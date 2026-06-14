"""AI Box — machine à états de l'approval-gate (pure, testable).

Port de services/app/src/lib/approval-gate.ts vers le modèle de hook Hermes.

Invariant de sécurité conservé : les paramètres APPROUVÉS ne peuvent pas être
permutés après coup. Dans BoxIA c'était garanti en réexécutant avec les params
du « pending » (pas du body). Ici un hook ``pre_tool_call`` ne peut que
bloquer/laisser-passer, pas réécrire les args — donc on garantit la même
propriété par VÉRIFICATION : l'approbation porte sur un hash des args ; si le
modèle change les args entre la demande et le ré-appel, le hash ne matche plus
→ re-bloqué.

État persisté sur disque : un fichier JSON par demande, sous
``$AIBOX_APPROVAL_DIR`` (def ``$HERMES_HOME/.aibox-approvals``).
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

DEFAULT_TTL_S = int(os.environ.get("AIBOX_APPROVAL_TTL_S", "300"))


def now() -> float:
    return time.time()


def _dir() -> Path:
    base = os.environ.get("AIBOX_APPROVAL_DIR") or os.path.join(
        os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")),
        ".aibox-approvals",
    )
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def args_hash(args: Any) -> str:
    canon = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _file(rec_id: str) -> Path:
    return _dir() / f"{rec_id}.json"


def _read(rec_id: str) -> Optional[dict]:
    try:
        return json.loads(_file(rec_id).read_text("utf-8"))
    except Exception:
        return None


def _write(rec: dict) -> None:
    _file(rec["id"]).write_text(json.dumps(rec, ensure_ascii=False, indent=2), "utf-8")


def _remove(rec_id: str) -> None:
    try:
        _file(rec_id).unlink()
    except OSError:
        pass


def create_pending(
    tool_name: str,
    args: Any,
    description: str = "",
    session_id: str = "",
    ttl_s: int = DEFAULT_TTL_S,
) -> dict:
    rec = {
        "id": secrets.token_hex(8),
        "tool_name": tool_name,
        "args_hash": args_hash(args),
        "args": args,
        "description": description or tool_name,
        "session_id": session_id,
        "status": "pending",
        "created_at": now(),
        "expires_at": now() + ttl_s,
    }
    _write(rec)
    return rec


def list_pending(session_id: Optional[str] = None) -> list[dict]:
    out: list[dict] = []
    for f in _dir().glob("*.json"):
        rec = _read(f.stem)
        if not rec:
            continue
        if now() > rec["expires_at"]:
            _remove(rec["id"])
            continue
        if rec["status"] != "pending":
            continue
        if session_id and rec.get("session_id") and rec["session_id"] != session_id:
            continue
        out.append(rec)
    return sorted(out, key=lambda r: r["created_at"], reverse=True)


def find_for(tool_name: str, args: Any) -> Optional[dict]:
    """Enregistrement (tout statut, non expiré) matchant exactement (tool, args)."""
    h = args_hash(args)
    for f in _dir().glob("*.json"):
        rec = _read(f.stem)
        if not rec or rec["tool_name"] != tool_name or rec["args_hash"] != h:
            continue
        if now() > rec["expires_at"]:
            _remove(rec["id"])
            continue
        return rec
    return None


def decide(rec_id: str, approved: bool) -> Optional[dict]:
    rec = _read(rec_id)
    if not rec:
        return None
    if now() > rec["expires_at"]:
        _remove(rec_id)
        return None
    if rec["status"] != "pending":
        return rec
    rec["status"] = "approved" if approved else "rejected"
    _write(rec)
    return rec


def evaluate(
    tool_name: str,
    args: Any,
    description: str = "",
    session_id: str = "",
    ttl_s: int = DEFAULT_TTL_S,
) -> tuple[str, dict]:
    """Cœur de la décision (pur). Retourne (verdict, record).

    verdict ∈ {allow, created, pending, rejected} :
      - allow    : déjà approuvé pour ces args exacts → consommé, le tool peut s'exécuter
      - created  : aucune demande → nouvelle demande pending créée (bloquer)
      - pending  : demande déjà en attente pour ces args (bloquer)
      - rejected : demande refusée par l'utilisateur (bloquer, consommé)
    """
    rec = find_for(tool_name, args)
    if rec and rec["status"] == "approved":
        _remove(rec["id"])
        return "allow", rec
    if rec and rec["status"] == "pending":
        return "pending", rec
    if rec and rec["status"] == "rejected":
        _remove(rec["id"])
        return "rejected", rec
    rec = create_pending(tool_name, args, description, session_id, ttl_s)
    return "created", rec
