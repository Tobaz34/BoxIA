"""Fetch top community templates from n8n.io and build a local catalogue.

Pourquoi : la marketplace n8n côté BoxIA expose actuellement 9 workflows
"officiels BoxIA" (taillés pour notre stack). Pour donner à l'admin une
quantité utile (l'utilisateur s'attend aux 9000+ de n8n.io community),
on importe un sous-ensemble curé des templates les plus populaires.

Approche : on appelle l'API publique n8n.io
   GET https://api.n8n.io/api/templates/workflows?rows=N&page=K&sort_by=totalViews
Pour chaque entrée retenue, on fetche aussi le détail
   GET https://api.n8n.io/api/templates/workflows/{id}
qui contient `workflow.nodes` + `workflow.connections` (importables tels quels
dans n8n via POST /rest/workflows).

Filtrage : on prend uniquement les top X par totalViews. Pas de filtrage
sur les nodes (l'admin verra ce qu'il y a et choisira).

Usage :
    python3 scripts/fetch_n8n_community_templates.py --top 50 --out templates/n8n/marketplace/community/

Génère :
    templates/n8n/marketplace/community/_index.json   (catalogue plat)
    templates/n8n/marketplace/community/<id>.json     (1 fichier par template)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import urllib.request
import urllib.error

API_BASE = "https://api.n8n.io/api/templates"
USER_AGENT = "AI-Box/0.2.0 (https://github.com/Tobaz34/BoxIA)"


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_listing(top: int) -> list[dict]:
    """Récupère top N templates triés par totalViews. L'API page par 100."""
    items: list[dict] = []
    page = 0
    while len(items) < top:
        url = f"{API_BASE}/workflows?rows=100&page={page}&sort_by=totalViews"
        try:
            data = http_json(url)
        except urllib.error.HTTPError as e:
            print(f"[fetch] page {page} HTTP {e.code} : {e}", file=sys.stderr)
            break
        batch = data.get("workflows", [])
        if not batch:
            break
        items.extend(batch)
        page += 1
        if page >= 5:  # safety : max 500 templates
            break
    return items[:top]


def fetch_detail(template_id: int) -> dict | None:
    """Récupère le workflow complet (nodes/connections importables)."""
    try:
        data = http_json(f"{API_BASE}/workflows/{template_id}")
        return data.get("workflow", {})
    except Exception as e:
        print(f"[detail] {template_id} : {e}", file=sys.stderr)
        return None


def derive_icon(name: str, nodes: list[dict]) -> str:
    """Devine un emoji selon le nom + les nodes utilisés."""
    n = name.lower()
    node_names = " ".join((n.get("name", "") or "") for n in nodes).lower()
    rules = [
        ("ai agent", "🤖"), ("agent", "🤖"), ("openai", "🧠"), ("claude", "🧠"),
        ("rag", "📚"), ("vector", "📚"), ("qdrant", "📚"), ("pinecone", "📚"),
        ("scrape", "🕷️"), ("crawl", "🕷️"),
        ("email", "✉️"), ("gmail", "✉️"), ("smtp", "✉️"), ("imap", "📧"),
        ("slack", "💬"), ("telegram", "💬"), ("discord", "💬"),
        ("notion", "📝"), ("airtable", "📊"), ("sheets", "📊"),
        ("github", "🐙"), ("gitlab", "🦊"),
        ("schedule", "🕐"), ("cron", "🕐"),
        ("webhook", "🪝"), ("api", "🔌"),
        ("calendar", "📅"), ("meet", "📅"), ("zoom", "📅"),
        ("invoice", "🧾"), ("facture", "🧾"), ("crm", "👔"),
        ("hr", "👥"), ("recruit", "👥"),
        ("translation", "🌐"), ("translate", "🌐"),
        ("youtube", "📹"), ("video", "📹"),
        ("image", "🖼️"), ("photo", "🖼️"),
        ("pdf", "📄"), ("document", "📄"),
        ("twitter", "🐦"), ("x.com", "🐦"), ("linkedin", "💼"),
    ]
    for needle, emoji in rules:
        if needle in n or needle in node_names:
            return emoji
    return "⚙️"


def derive_category(name: str, description: str, nodes: list[dict]) -> str:
    """Catégorise selon mots-clés. 6 catégories (alignées avec _catalog.json)."""
    text = (name + " " + (description or "")).lower()
    node_names = " ".join((nd.get("name", "") or "") for nd in nodes).lower()
    pairs = [
        ("monitoring", ["monitor", "alert", "uptime", "watchdog", "health"]),
        ("backup", ["backup", "snapshot", "archive", "dump"]),
        ("rag", ["rag", "vector", "qdrant", "pinecone", "embed", "knowledge", "ingest"]),
        ("email", ["email", "gmail", "imap", "smtp", "mail"]),
        ("helpdesk", ["ticket", "helpdesk", "support", "zendesk", "freshdesk", "glpi"]),
        ("finance", ["invoice", "facture", "payment", "stripe", "paypal", "accounting"]),
        ("sales", ["crm", "salesforce", "hubspot", "pipedrive", "lead"]),
    ]
    for cat, kws in pairs:
        if any(kw in text or kw in node_names for kw in kws):
            return cat
    return "misc"


def build_entry(meta: dict, full_workflow: dict | None) -> dict | None:
    """Construit une entrée du catalogue + le JSON workflow importable."""
    if not full_workflow:
        return None
    tid = meta.get("id")
    name = meta.get("name", "").strip()
    if not name:
        return None
    nodes = full_workflow.get("nodes", []) or []
    connections = full_workflow.get("connections", {}) or {}
    if not nodes:
        return None

    description = ""
    raw_desc = (meta.get("description") or "").strip()
    if raw_desc:
        # Garde juste les 2-3 premières lignes utiles
        for line in raw_desc.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith(">"):
                continue
            description = line[:300]
            break

    return {
        "catalog_entry": {
            "file": f"community/{tid}.json",
            "n8n_template_id": tid,
            "name": name,
            "icon": derive_icon(name, nodes),
            "category": derive_category(name, description, nodes),
            "description": description or f"Template communautaire n8n.io #{tid}",
            "difficulty": "moyen",
            "credentials_required": ["Voir nodes du workflow"],
            "boxia_services": [],
            "default_active": False,
            "source": "n8n.io community",
            "source_url": f"https://n8n.io/workflows/{tid}/",
            "total_views": meta.get("totalViews", 0),
            "author": (meta.get("user") or {}).get("username", ""),
        },
        "workflow_json": {
            "name": name,
            "nodes": nodes,
            "connections": connections,
            "settings": (full_workflow.get("meta") or {}).get("settings")
                or {"executionOrder": "v1"},
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=50)
    ap.add_argument("--out", default="templates/n8n/marketplace/community")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[fetch] listing top {args.top} from n8n.io…")
    listing = fetch_listing(args.top)
    print(f"[fetch] got {len(listing)} entries")

    catalog: list[dict] = []
    for i, meta in enumerate(listing):
        tid = meta.get("id")
        if not tid:
            continue
        print(f"  [{i+1}/{len(listing)}] {tid} — {meta.get('name', '?')[:60]}")
        full = fetch_detail(tid)
        entry = build_entry(meta, full)
        if not entry:
            continue
        # Écrit le fichier workflow individuel
        wf_path = out_dir / f"{tid}.json"
        wf_path.write_text(
            json.dumps(entry["workflow_json"], indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        catalog.append(entry["catalog_entry"])

    index = {
        "version": 1,
        "source": "n8n.io community templates API",
        "fetched_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "count": len(catalog),
        "workflows": catalog,
    }
    (out_dir / "_index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[done] {len(catalog)} workflows → {out_dir}/")


if __name__ == "__main__":
    main()
