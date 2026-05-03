#!/usr/bin/env python3
"""Joue les migrations DB non encore appliquées.

Lance toutes les migrations 0001_*.py, 0002_*.py… présentes dans tools/migrations/
qui ne sont pas encore enregistrées dans _state.json. Idempotent.

Usage:
    python3 tools/migrations/run-pending.py              # joue les migrations pendantes
    python3 tools/migrations/run-pending.py --list       # liste les migrations + statut
    python3 tools/migrations/run-pending.py --reset-state  # rejoue TOUT depuis zéro
                                                            (utile après un reset client)
    python3 tools/migrations/run-pending.py --dry-run    # affiche sans exécuter

Exit codes:
    0 — OK
    1 — au moins une migration a échoué
    2 — usage incorrect
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import re
import sys
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent
STATE_FILE = MIGRATIONS_DIR / "_state.json"
MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.py$")


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"applied": [], "version": 1}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"⚠ {STATE_FILE} corrompu — repart de zéro", file=sys.stderr)
        return {"applied": [], "version": 1}


def save_state(state: dict) -> None:
    state["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    STATE_FILE.write_text(
        json.dumps(state, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def list_migrations() -> list[Path]:
    """Liste les fichiers de migration triés par numéro."""
    out = []
    for f in sorted(MIGRATIONS_DIR.iterdir()):
        if f.is_file() and MIGRATION_RE.match(f.name):
            out.append(f)
    return out


def load_migration(path: Path):
    """Charge dynamiquement le module de migration."""
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Impossible de charger {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for attr in ("run", "is_applied", "DESCRIPTION"):
        if not hasattr(module, attr):
            raise RuntimeError(f"{path.name} : attr `{attr}` manquant")
    return module


def cmd_list(state: dict) -> int:
    applied = set(state.get("applied", []))
    print(f"{'#':4}  {'STATUT':10}  {'NOM':40}  DESCRIPTION")
    print("-" * 100)
    for f in list_migrations():
        try:
            m = load_migration(f)
            desc = m.DESCRIPTION
        except Exception as e:
            desc = f"❌ erreur load: {e}"
        status = "✓ applied" if f.name in applied else "⏳ pending"
        print(f"{f.name[:4]:4}  {status:10}  {f.name:40}  {desc}")
    return 0


def cmd_run(state: dict, dry_run: bool = False) -> int:
    applied = set(state.get("applied", []))
    failures = 0
    ran = 0
    for f in list_migrations():
        if f.name in applied:
            continue
        print(f"\n▶ {f.name}")
        try:
            m = load_migration(f)
            print(f"  description: {m.DESCRIPTION}")
            if m.is_applied():
                print(f"  → déjà appliquée (is_applied=True), marque comme appliquée")
                state.setdefault("applied", []).append(f.name)
                continue
            if dry_run:
                print(f"  → dry-run, skip exécution")
                continue
            m.run()
            state.setdefault("applied", []).append(f.name)
            print(f"  ✓ {f.name} OK")
            ran += 1
        except Exception as e:
            print(f"  ✗ {f.name} ÉCHEC : {e}", file=sys.stderr)
            failures += 1
            # On continue avec les suivantes — certaines peuvent être indépendantes
    if not dry_run:
        save_state(state)
    print(f"\n{'=' * 60}")
    print(f"Bilan : {ran} migration(s) jouée(s), {failures} échec(s)")
    return 0 if failures == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--list", action="store_true", help="liste les migrations et leur statut")
    p.add_argument("--reset-state", action="store_true", help="rejoue toutes les migrations depuis zéro")
    p.add_argument("--dry-run", action="store_true", help="affiche sans exécuter")
    args = p.parse_args()

    if args.reset_state:
        print("⚠ Reset de _state.json — toutes les migrations seront rejouées")
        state = {"applied": [], "version": 1}
    else:
        state = load_state()

    if args.list:
        return cmd_list(state)
    return cmd_run(state, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
