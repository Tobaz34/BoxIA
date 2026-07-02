"""Audit append-only des tool calls (port de services/app/src/lib/app-audit.ts).

Pur & testable. Écrit un JSONL local (sur le PC dédié du client → la PII reste
chez lui, conforme « tout reste sur le PC dédié »). Rotation à N entrées.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

DEFAULT_MAX = int(os.environ.get("AIBOX_AUDIT_MAX_ENTRIES", "5000"))


def audit_path() -> Path:
    p = os.environ.get("AIBOX_AUDIT_FILE") or os.path.join(
        os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")),
        ".aibox-audit.jsonl",
    )
    path = Path(p)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def build_record(
    tool_name: str,
    args: Any = None,
    result: Any = None,
    duration_ms: int = 0,
    session_id: str = "",
    ts: Optional[float] = None,
    mutating: bool = False,
) -> dict:
    """Construit une ligne d'audit compacte (args tronqués à 200 car.)."""
    is_error = False
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            is_error = isinstance(parsed, dict) and "error" in parsed
        except Exception:
            pass
    return {
        "ts": ts if ts is not None else time.time(),
        "tool": tool_name,
        "args": json.dumps(args, ensure_ascii=False, default=str)[:200] if args else "",
        "session": session_id or "",
        "duration_ms": int(duration_ms or 0),
        "mutating": bool(mutating),
        "error": is_error,
    }


def append(record: dict, path: Optional[Path] = None, max_entries: int = DEFAULT_MAX) -> None:
    path = path or audit_path()
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    _rotate(path, max_entries)


def _rotate(path: Path, max_entries: int) -> None:
    try:
        lines = [ln for ln in path.read_text("utf-8").splitlines() if ln.strip()]
    except OSError:
        return
    if len(lines) > max_entries:
        path.write_text("\n".join(lines[-max_entries:]) + "\n", "utf-8")


def read_all(path: Optional[Path] = None) -> list[dict]:
    path = path or audit_path()
    try:
        raw = path.read_text("utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for ln in raw:
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except (json.JSONDecodeError, ValueError):
            # Ligne corrompue (écriture interrompue, edit manuel) → on la saute
            # au lieu de faire crasher /aibox-audit à vie.
            continue
    return out
