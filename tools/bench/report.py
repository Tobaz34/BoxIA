"""Génère un rapport HTML autonome (no JS framework, no CDN) à partir des
résultats du bench. Lisible offline.
"""
from __future__ import annotations

import html
import json
from typing import Any


CATEGORY_ICON = {
    "accounting": "💰",
    "vision": "👁️",
    "rag": "📚",
    "files": "📄",
    "tools": "🔧",
    "compliance": "⚖️",
    "robustness": "🛡️",
}


def _fmt_pct(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v:.1f}%"


def _color_for(pct: float | None) -> str:
    if pct is None:
        return "#666"
    if pct >= 80:
        return "#10b981"  # green
    if pct >= 60:
        return "#f59e0b"  # amber
    if pct >= 30:
        return "#f97316"  # orange
    return "#ef4444"  # red


def _bar(pct: float | None, width: int = 100) -> str:
    if pct is None:
        return f'<div class="bar bar-empty" style="width:{width}px"></div>'
    color = _color_for(pct)
    return (
        f'<div class="bar" style="width:{width}px">'
        f'<div class="bar-fill" style="width:{min(100, pct)}%;background:{color}"></div>'
        f'<span class="bar-label">{pct:.0f}%</span>'
        f'</div>'
    )


def render_html(results: list[dict], summary: dict) -> str:
    meta = summary.get("meta", {})
    rows = []
    for r in results:
        pid = html.escape(r["prompt_id"])
        cat = r["category"]
        cat_icon = CATEGORY_ICON.get(cat, "•")
        agent = html.escape(r.get("agent") or "")
        if r.get("skipped"):
            rows.append(
                f'<tr class="skipped"><td>{cat_icon} {cat}</td><td>{pid}</td>'
                f'<td>{agent}</td>'
                f'<td colspan="4" class="skip-cell">⏭ {html.escape(r.get("skip_reason", ""))}</td></tr>'
            )
            continue

        ls = r["local"]["score"]["score_pct"] if r.get("local") else None
        cs = r["cloud"]["score"]["score_pct"] if r.get("cloud") else None
        ll = r["local"]["elapsed_s"] if r.get("local") else None
        cl = r["cloud"]["elapsed_s"] if r.get("cloud") else None

        delta = (ls - cs) if (ls is not None and cs is not None) else None
        delta_str = ""
        if delta is not None:
            sign = "+" if delta >= 0 else ""
            delta_color = "#10b981" if delta >= -10 else "#ef4444"
            delta_str = f'<span style="color:{delta_color}">{sign}{delta:.0f}</span>'

        rows.append(
            f'<tr class="cat-{cat}">'
            f'<td>{cat_icon} {html.escape(cat)}</td>'
            f'<td><a href="#raw-{pid}">{pid}</a></td>'
            f'<td>{agent}</td>'
            f'<td>{_bar(ls)} <small>{ll:.1f}s</small></td>' if ll else f'<td>{_bar(ls)}</td>'
        )
        rows[-1] += (
            f'<td>{_bar(cs)} <small>{cl:.1f}s</small></td>' if cl else f'<td>{_bar(cs)}</td>'
        )
        rows[-1] += f'<td class="delta">{delta_str}</td></tr>'

    # Per-category summary
    cat_rows = []
    for cat, d in summary.get("by_category", {}).items():
        ls, cs = d["local_avg"], d["cloud_avg"]
        delta = ls - cs
        sign = "+" if delta >= 0 else ""
        delta_color = "#10b981" if delta >= -10 else "#ef4444"
        cat_rows.append(
            f'<tr><td>{CATEGORY_ICON.get(cat, "•")} {html.escape(cat)} ({d["n"]})</td>'
            f'<td>{_bar(ls)}</td><td>{_bar(cs)}</td>'
            f'<td><span style="color:{delta_color}">{sign}{delta:.0f}</span></td></tr>'
        )

    # Raw responses (collapsible details)
    raw_blocks = []
    for r in results:
        if r.get("skipped"):
            continue
        pid = html.escape(r["prompt_id"])
        local_ans = html.escape(r["local"]["answer"])[:5000] if r.get("local") else "(skip)"
        cloud_ans = html.escape(r["cloud"]["answer"])[:5000] if r.get("cloud") else "(skip)"
        local_score_html = ""
        cloud_score_html = ""
        if r.get("local"):
            ld = r["local"]["score"]["details"]
            local_score_html = "".join(
                f'<li class="{"ok" if x["passed"] else "fail"}">'
                f'<b>{html.escape(x["scorer_type"])}</b> · {html.escape(x["details"])}</li>'
                for x in ld
            )
        if r.get("cloud"):
            cd = r["cloud"]["score"]["details"]
            cloud_score_html = "".join(
                f'<li class="{"ok" if x["passed"] else "fail"}">'
                f'<b>{html.escape(x["scorer_type"])}</b> · {html.escape(x["details"])}</li>'
                for x in cd
            )
        raw_blocks.append(f"""
<details id="raw-{pid}">
  <summary>{pid}</summary>
  <div class="raw-grid">
    <div>
      <h4>📍 LOCAL ({r["local"]["elapsed_s"]:.1f}s, {r["local"]["score"]["score_pct"]:.0f}%)</h4>
      <ul class="scorers">{local_score_html}</ul>
      <pre>{local_ans}</pre>
    </div>
    <div>
      <h4>☁️ CLOUD ({r["cloud"]["elapsed_s"]:.1f}s, {r["cloud"]["score"]["score_pct"]:.0f}%)</h4>
      <ul class="scorers">{cloud_score_html}</ul>
      <pre>{cloud_ans}</pre>
    </div>
  </div>
</details>
""" if r.get("local") and r.get("cloud") else "")

    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Bench AI Box — local vs cloud</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1200px;
          margin: 1.5rem auto; padding: 0 1rem; color: #e4e4e7; background: #18181b; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; }}
  h2 {{ font-size: 1.1rem; margin-top: 2rem; color: #a1a1aa; }}
  .meta {{ color: #71717a; font-size: 0.85rem; margin-bottom: 2rem; }}
  .meta code {{ background: #27272a; padding: 1px 6px; border-radius: 4px; }}
  .summary-cards {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.8rem;
                    margin-bottom: 2rem; }}
  .card {{ background: #27272a; padding: 0.9rem; border-radius: 6px;
           border: 1px solid #3f3f46; }}
  .card h3 {{ font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
              color: #a1a1aa; margin: 0 0 0.4rem; }}
  .card .v {{ font-size: 1.6rem; font-weight: 600; tabular-nums: true; }}
  .card .sub {{ font-size: 0.7rem; color: #a1a1aa; margin-top: 0.2rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
  th, td {{ text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #3f3f46; }}
  th {{ font-weight: 500; color: #a1a1aa; font-size: 0.7rem; text-transform: uppercase; }}
  tr.skipped td {{ color: #52525b; font-style: italic; }}
  tr.skipped .skip-cell {{ color: #71717a; }}
  td.delta {{ text-align: right; tabular-nums: true; }}
  .bar {{ position: relative; height: 18px; background: #27272a; border-radius: 3px;
          display: inline-block; vertical-align: middle; }}
  .bar-fill {{ height: 100%; border-radius: 3px; transition: width 0.3s; }}
  .bar-label {{ position: absolute; left: 6px; top: 1px; font-size: 0.7rem;
                color: #fff; mix-blend-mode: difference; tabular-nums: true; }}
  .bar-empty::after {{ content: '—'; color: #52525b; padding-left: 6px; }}
  details {{ background: #27272a; border-radius: 6px; padding: 0.8rem 1rem;
              margin-bottom: 0.5rem; border: 1px solid #3f3f46; }}
  details summary {{ cursor: pointer; font-family: monospace; }}
  .raw-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }}
  .raw-grid h4 {{ margin: 0 0 0.5rem; font-size: 0.85rem; }}
  .raw-grid pre {{ background: #18181b; padding: 0.6rem; border-radius: 4px;
                   font-size: 0.75rem; max-height: 280px; overflow: auto;
                   white-space: pre-wrap; }}
  .scorers {{ list-style: none; padding-left: 0; font-size: 0.75rem;
              margin: 0 0 0.5rem; }}
  .scorers li {{ padding: 2px 0; }}
  .scorers li.ok::before {{ content: '✓ '; color: #10b981; }}
  .scorers li.fail::before {{ content: '✗ '; color: #ef4444; }}
  small {{ color: #a1a1aa; margin-left: 6px; tabular-nums: true; }}
</style>
</head>
<body>

<h1>Bench AI Box — local vs cloud</h1>
<div class="meta">
  Généré : {html.escape(meta.get("generated_at", "—"))} ·
  base : <code>{html.escape(meta.get("base_url", "—"))}</code> ·
  cloud : <code>{html.escape(meta.get("cloud_provider", "—"))}/{html.escape(meta.get("cloud_model", "—"))}</code> ·
  durée : {meta.get("elapsed_s", 0):.0f}s ·
  prompts : {meta.get("n_executed", 0)} exécutés / {meta.get("n_prompts", 0)} planifiés
</div>

<div class="summary-cards">
  <div class="card">
    <h3>Score local</h3>
    <div class="v" style="color:{_color_for(summary.get("local_avg_score"))}">{_fmt_pct(summary.get("local_avg_score"))}</div>
    <div class="sub">moyenne tous prompts</div>
  </div>
  <div class="card">
    <h3>Score cloud</h3>
    <div class="v" style="color:{_color_for(summary.get("cloud_avg_score"))}">{_fmt_pct(summary.get("cloud_avg_score"))}</div>
    <div class="sub">référence (ceiling)</div>
  </div>
  <div class="card">
    <h3>Ratio L/C</h3>
    <div class="v" style="color:{_color_for(summary.get("ratio_local_over_cloud", 0) * 100)}">{summary.get("ratio_local_over_cloud", 0)*100:.0f}%</div>
    <div class="sub">local en % du cloud</div>
  </div>
  <div class="card">
    <h3>Latence</h3>
    <div class="v">{summary.get("local_avg_latency_s", 0):.1f}s / {summary.get("cloud_avg_latency_s", 0):.1f}s</div>
    <div class="sub">local vs cloud (moy.)</div>
  </div>
</div>

<h2>Score par catégorie</h2>
<table>
  <thead><tr><th>Catégorie</th><th>Local</th><th>Cloud</th><th>Δ</th></tr></thead>
  <tbody>
{"".join(cat_rows)}
  </tbody>
</table>

<h2>Détail par prompt</h2>
<table>
  <thead><tr><th>Cat.</th><th>Prompt ID</th><th>Agent</th><th>Local</th><th>Cloud</th><th>Δ</th></tr></thead>
  <tbody>
{"".join(rows)}
  </tbody>
</table>

<h2>Réponses brutes (cliquer pour déplier)</h2>
{"".join(raw_blocks)}

</body>
</html>
"""


if __name__ == "__main__":
    # Test minimal
    import sys
    if len(sys.argv) < 2:
        print("Usage: python3 report.py <path/to/results.json>")
        sys.exit(2)
    data = json.loads(open(sys.argv[1], encoding="utf-8").read())
    print(render_html(data["results"], data["summary"]))
