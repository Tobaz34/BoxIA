#!/usr/bin/env python3
"""Analyse rapide d'un run de bench. Lit results.json et imprime un
résumé des prompts qui ont fail, avec le détail des scorers et un
extrait de la réponse locale.

Usage : python3 tools/bench/analyze.py <path/to/results.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: analyze.py <path/to/results.json>", file=sys.stderr)
        return 2
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    results = data["results"]
    summary = data.get("summary", {})

    print("=" * 78)
    print(f"  Run summary : local {summary.get('local_avg_score', 0):.1f}% / "
          f"cloud {summary.get('cloud_avg_score', 0):.1f}% / "
          f"ratio {(summary.get('ratio_local_over_cloud') or 0) * 100:.0f}%")
    print(f"  Latence moy : local {summary.get('local_avg_latency_s', 0):.1f}s / "
          f"cloud {summary.get('cloud_avg_latency_s', 0):.1f}s")
    print("=" * 78)

    for r in results:
        if r.get("skipped"):
            continue
        l = r.get("local") or {}
        c = r.get("cloud") or {}
        ls = (l.get("score") or {}).get("score_pct") or 0
        cs = (c.get("score") or {}).get("score_pct") or 0
        delta = ls - cs
        marker = "🔴" if delta < -20 else "🟡" if delta < -10 else "🟢"
        print()
        print(f"{marker} {r['prompt_id']:32}  L={ls:5.1f}%  C={cs:5.1f}%  "
              f"Δ={delta:+6.1f}  latL={l.get('elapsed_s', 0):5.1f}s")
        # Détail scorers local
        for s in (l.get("score") or {}).get("details", []):
            mark = "✓" if s["passed"] else "✗"
            print(f"    L {mark} {s['scorer_type']:24} {s['details']}")
        # Réponse locale (excerpt)
        ans = (l.get("answer") or "").strip()
        if ans:
            ans_excerpt = ans[:600].replace("\n", " ⏎ ")
            print(f"    L answer ({len(ans)} chars) : {ans_excerpt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
