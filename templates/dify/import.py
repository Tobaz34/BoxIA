#!/usr/bin/env python3
"""
Importe tous les templates YAML Dify dans une instance Dify via son API.

Usage :
  DIFY_API_URL=http://localhost:8081  DIFY_API_KEY=xxx  python import.py
  python import.py templates/dify/agent_qa_documents.yml   # un seul

Variables d'env :
  DIFY_API_URL      URL Dify (avec scheme)
  DIFY_API_KEY      Clé API d'un workspace Dify (Settings > API > Generate)
  TENANT_ID         Slug client (substitué dans les templates)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from string import Template

import httpx
import yaml

DIFY_API_URL = os.environ.get("DIFY_API_URL", "http://aibox-dify-nginx:80").rstrip("/")
DIFY_API_KEY = os.environ.get("DIFY_API_KEY", "")
TENANT_ID = os.environ.get("TENANT_ID", "default")

if not DIFY_API_KEY:
    print("ERREUR : DIFY_API_KEY manquante. Génère-la dans Dify > Settings > API.",
          file=sys.stderr)
    sys.exit(2)


def expand_vars(obj):
    """Substitue ${TENANT_ID} récursivement dans la structure."""
    if isinstance(obj, str):
        return Template(obj).safe_substitute(TENANT_ID=TENANT_ID)
    if isinstance(obj, dict):
        return {k: expand_vars(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [expand_vars(v) for v in obj]
    return obj


def import_template(path: Path) -> None:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    expanded = expand_vars(raw)

    # NB : l'API Dify v1 a un endpoint /apps/import qui prend un YAML/JSON
    # natif Dify (DSL). Notre format YAML est plus haut niveau pour lisibilité ;
    # ici on convertit vers la structure Dify minimale attendue.
    dify_dsl = {
        "version": "0.1.0",
        "kind": "app",
        "name": expanded["app"]["name"],
        "description": expanded["app"]["description"],
        "icon": expanded["app"].get("icon", "🤖"),
        "mode": expanded["app"]["mode"],
        "model_config": {
            "model": {
                "provider": expanded["model"]["provider"],
                "name": expanded["model"]["name"],
                "parameters": expanded["model"].get("parameters", {}),
            },
            "pre_prompt": expanded["prompt"],
            "opening_statement": expanded.get("opening_statement", ""),
        },
        "knowledge": expanded.get("knowledge", []),
        "tools": expanded.get("tools", []),
    }

    headers = {"Authorization": f"Bearer {DIFY_API_KEY}", "Content-Type": "application/json"}
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{DIFY_API_URL}/api/apps/import", json=dify_dsl, headers=headers)
        if r.status_code >= 400:
            print(f"  ✗ {path.name}: HTTP {r.status_code} {r.text[:200]}")
            return
        data = r.json()
        print(f"  ✓ {path.name} → {data.get('name')} (id={data.get('id', '?')})")


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]] or list(Path(__file__).parent.glob("*.yml"))
    paths = [p for p in paths if p.suffix in (".yml", ".yaml") and p.name != "import.py"]
    print(f"Import de {len(paths)} template(s) dans {DIFY_API_URL}")
    for p in paths:
        try:
            import_template(p)
        except Exception as e:
            print(f"  ✗ {p.name}: {e}")


if __name__ == "__main__":
    main()
