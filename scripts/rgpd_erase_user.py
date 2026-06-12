#!/usr/bin/env python3
"""
Droit à l'effacement (RGPD article 17) — purge un user dans tous les services.

Usage :
  python rgpd_erase_user.py <username>
  python rgpd_erase_user.py --dry-run <username>

Ce script lit le .env de la box pour les credentials internes.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm


def env(k: str, default: str = "") -> str:
    v = os.environ.get(k, default)
    if not v and default == "":
        print(f"⚠ Variable {k} manquante", file=sys.stderr)
    return v


# Échecs collectés au fil des étapes → exit 1 à la fin si non vide
_failures: list[str] = []


def _run_checked(cmd: list[str], label: str) -> bool:
    """Exécute la commande et collecte l'échec (au lieu de l'ignorer en silence)."""
    res = subprocess.run(cmd)
    if res.returncode != 0:
        _failures.append(f"{label} (exit {res.returncode})")
        print(f"  ⚠ {label} : échec (exit {res.returncode})", file=sys.stderr)
        return False
    return True


def _sqlite_quote(s: str) -> str:
    """Littéral SQL sûr pour sqlite3 CLI (pas de bind possible) : apostrophes doublées."""
    return "'" + s.replace("'", "''") + "'"


def erase_authentik(username: str, dry: bool) -> None:
    print(f"[Authentik] Suppression user {username}…")
    base = "http://aibox-authentik-server:9000/api/v3"
    token = env("AUTHENTIK_API_TOKEN")
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(headers=headers, timeout=30) as c:
        r = c.get(f"{base}/core/users/", params={"username": username})
        results = r.json().get("results", [])
        if not results:
            print(f"  → user introuvable")
            return
        pk = results[0]["pk"]
        if dry:
            print(f"  [dry-run] DELETE /core/users/{pk}/")
            return
        c.delete(f"{base}/core/users/{pk}/")
        print(f"  ✓ supprimé")


def erase_qdrant(username: str, dry: bool) -> None:
    print(f"[Qdrant] Purge des chunks référençant l'user…")
    qd = QdrantClient(url=env("QDRANT_URL", "http://aibox-qdrant:6333"),
                      api_key=env("QDRANT_API_KEY") or None)
    collections = [c.name for c in qd.get_collections().collections]
    for col in collections:
        try:
            f = qm.Filter(should=[
                qm.FieldCondition(key="acl_users", match=qm.MatchValue(value=username)),
                qm.FieldCondition(key="created_by", match=qm.MatchValue(value=username)),
            ])
            if dry:
                count = qd.count(col, count_filter=f).count
                print(f"  [dry-run] {col} : {count} chunks à supprimer")
                continue
            qd.delete(col, points_selector=qm.FilterSelector(filter=f))
            print(f"  ✓ {col} purgé")
        except Exception as e:
            print(f"  ⚠ {col} : {e}")


def erase_owui(username: str, dry: bool) -> None:
    print(f"[Open WebUI] Purge conversations + uploads…")
    usr = _sqlite_quote(username)  # anti-injection SQL
    cmd = [
        "docker", "exec", "open-webui", "sqlite3", "/app/backend/data/webui.db",
        f"DELETE FROM chat WHERE user_id IN (SELECT id FROM user WHERE name={usr} OR email={usr}); "
        f"DELETE FROM user WHERE name={usr} OR email={usr};",
    ]
    if dry:
        print(f"  [dry-run] {' '.join(cmd)}")
        return
    if _run_checked(cmd, "open-webui"):
        print("  ✓ owui purgé")


def erase_dify(username: str, dry: bool) -> None:
    print(f"[Dify] Suppression compte + données…")
    # Dify v1.10 : supprimer via SQL direct dans la DB Dify.
    # Anti-injection : la valeur passe par une variable psql (-v) interpolée
    # en littéral quoté via :'usr' — jamais par f-string dans le SQL.
    cmd = [
        "docker", "exec", "aibox-dify-db", "psql", "-U", "postgres", "-d", "dify",
        "-v", "ON_ERROR_STOP=1",
        "-v", f"usr={username}",
        "-c",
        "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE from_account_id IN (SELECT id FROM accounts WHERE email=:'usr')); "
        "DELETE FROM conversations WHERE from_account_id IN (SELECT id FROM accounts WHERE email=:'usr'); "
        "DELETE FROM accounts WHERE email=:'usr';",
    ]
    if dry:
        print(f"  [dry-run] {' '.join(cmd[:6])} ...")
        return
    if _run_checked(cmd, "dify"):
        print("  ✓ dify purgé")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("username")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    print(f"=== Effacement RGPD pour {args.username} {'(DRY RUN)' if args.dry_run else ''} ===")
    erase_authentik(args.username, args.dry_run)
    erase_qdrant(args.username, args.dry_run)
    erase_owui(args.username, args.dry_run)
    erase_dify(args.username, args.dry_run)
    print("=== Terminé ===")
    if _failures:
        print(f"⚠ Effacements en échec : {', '.join(_failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
