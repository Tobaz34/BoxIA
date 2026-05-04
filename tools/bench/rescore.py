#!/usr/bin/env python3
"""Re-score un run de bench existant avec la version actuelle de score.py.

Utile quand on découvre un bug dans un scorer (ex: regex `\\d{1,3}` qui
coupait les nombres ≥ 4 chiffres) — on peut réévaluer un run passé sans
relancer les ~25 min d'inférence LLM.

Usage :
    python3 tools/bench/rescore.py <path/to/results.json> [<path/to/prompts.json>]

Écrit le results.json en place avec les nouveaux scores. Le summary est
recalculé. Une copie de l'ancien est faite en results.json.before-rescore.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from score import score_response  # noqa: E402


def _build_summary(results: list[dict]) -> dict:
    def avg(values):
        vs = [v for v in values if v is not None]
        return sum(vs) / len(vs) if vs else 0.0

    local_scores = [r["local"]["score"]["score_pct"] for r in results if r.get("local")]
    cloud_scores = [r["cloud"]["score"]["score_pct"] for r in results if r.get("cloud")]
    local_lats = [r["local"]["elapsed_s"] for r in results if r.get("local")]
    cloud_lats = [r["cloud"]["elapsed_s"] for r in results if r.get("cloud")]

    by_cat: dict[str, dict] = {}
    for r in results:
        c = r["category"]
        d = by_cat.setdefault(c, {"local": [], "cloud": []})
        if r.get("local"):
            d["local"].append(r["local"]["score"]["score_pct"])
        if r.get("cloud"):
            d["cloud"].append(r["cloud"]["score"]["score_pct"])
    cat_summary = {
        c: {
            "local_avg": round(avg(d["local"]), 1),
            "cloud_avg": round(avg(d["cloud"]), 1),
            "n": max(len(d["local"]), len(d["cloud"])),
        }
        for c, d in by_cat.items()
    }

    local_avg = avg(local_scores)
    cloud_avg = avg(cloud_scores)
    return {
        "local_avg_score": round(local_avg, 1),
        "cloud_avg_score": round(cloud_avg, 1),
        "local_avg_latency_s": round(avg(local_lats), 1),
        "cloud_avg_latency_s": round(avg(cloud_lats), 1),
        "ratio_local_over_cloud": (local_avg / cloud_avg) if cloud_avg > 0 else 0.0,
        "n_skipped": sum(1 for r in results if r.get("skipped")),
        "by_category": cat_summary,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: rescore.py <path/to/results.json> [<path/to/prompts.json>]", file=sys.stderr)
        return 2
    results_path = Path(sys.argv[1])
    prompts_path = (
        Path(sys.argv[2]) if len(sys.argv) > 2 else (HERE / "prompts.json")
    )

    catalog = json.loads(prompts_path.read_text(encoding="utf-8-sig"))
    by_id = {p["id"]: p for p in catalog["prompts"]}

    raw = results_path.read_text(encoding="utf-8-sig")
    data = json.loads(raw)

    # Backup
    backup = results_path.with_suffix(".json.before-rescore")
    if not backup.exists():
        shutil.copy(results_path, backup)
        print(f"Backup : {backup}")

    n_changed = 0
    for r in data["results"]:
        pid = r["prompt_id"]
        prompt = by_id.get(pid)
        if not prompt:
            print(f"  ⚠ {pid}: pas dans prompts.json (skip rescoring)")
            continue
        scorers = prompt.get("scorers") or []
        for backend in ("local", "cloud"):
            payload = r.get(backend)
            if not payload or not payload.get("answer"):
                continue
            old = payload.get("score", {}).get("score_pct")
            new_score = score_response(payload["answer"], scorers)
            payload["score"] = new_score
            new = new_score["score_pct"]
            if old != new:
                n_changed += 1
                print(f"  ~ {pid:30} {backend}: {old} → {new}")

    # Recalcule summary
    new_summary = _build_summary(data["results"])
    # Préserve meta
    new_summary["meta"] = data["summary"].get("meta", {})
    new_summary["meta"]["rescored_at"] = __import__("datetime").datetime.now().isoformat()
    data["summary"] = new_summary

    results_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{n_changed} score(s) changé(s).")
    print(f"Nouveau résumé : local {new_summary['local_avg_score']}% / cloud {new_summary['cloud_avg_score']}% / ratio {new_summary['ratio_local_over_cloud']*100:.0f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
