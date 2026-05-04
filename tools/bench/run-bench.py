#!/usr/bin/env python3
"""Bench AI Box — exécute les prompts de prompts.json contre :
  - l'IA locale (qwen3:14b ou qwen2.5vl:7b selon agent) via /api/chat
  - le cloud (claude-sonnet-4-5 par défaut) via /api/chat-cloud

Mesure latence, longueur, score (via score.py), coût estimé. Sort un CSV
+ un dashboard HTML (via report.py).

Auth : utilise un cookie de session NextAuth fourni en argument
(--cookie "next-auth.session-token=..." ou via env BENCH_COOKIE).

Usage :
  # Récupérer le cookie depuis Chrome (DevTools → Application → Cookies)
  export BENCH_COOKIE="next-auth.session-token=eyJhbGc..."

  # Lancer tout le bench (30 prompts × 2 backends = 60 requêtes ~30 min)
  python3 tools/bench/run-bench.py --base-url http://192.168.15.210:3100

  # Lancer une seule catégorie
  python3 tools/bench/run-bench.py --category accounting

  # Lancer un seul prompt (debug)
  python3 tools/bench/run-bench.py --prompt-id acc-02-releve-bancaire

  # Lancer en local seulement (skip cloud)
  python3 tools/bench/run-bench.py --skip-cloud

  # Dry-run : affiche les prompts sans exécuter
  python3 tools/bench/run-bench.py --dry-run

Sortie :
  tools/bench/runs/<timestamp>/
    results.csv
    results.json
    report.html
    raw/<prompt_id>.<backend>.json   # full response per call

Exit codes :
  0 — bench terminé (même si certains scores < 100%)
  1 — erreur infra (auth, network, timeout système)
  2 — usage incorrect
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from score import score_response  # noqa: E402

DEFAULT_BASE_URL = os.environ.get("BENCH_BASE_URL", "http://192.168.15.210:3100")
DEFAULT_CLOUD_PROVIDER = "anthropic"
DEFAULT_CLOUD_MODEL = "claude-sonnet-4-5"
# Fallback automatique si le primaire (anthropic) renvoie HTTP 5xx (budget,
# rate-limit, panne API). On bascule sur Google Gemini Flash qui est rapide
# et bon marché. C'est ce qui fait la différence entre "test fair" et le
# "ratio L/C 134%" trompeur quand un seul provider tombe.
FALLBACK_PROVIDER = "google"
FALLBACK_MODEL = "gemini-2.5-flash"


# ---- HTTP helpers ---------------------------------------------------------


def _post_sse(
    url: str, body: dict, cookie: str, timeout_s: int, retries: int = 2,
) -> tuple[str, dict]:
    """POST JSON, lit le SSE stream Dify-like, recompose le `answer` final
    et le `metadata` (usage, file markers).

    Retourne (full_answer_text, meta_dict).

    SSE format :
      data: {"event":"message","answer":"chunk"}
      data: {"event":"message_end","metadata":{...}}
    """
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Cookie": cookie,
        },
        method="POST",
    )
    answer_parts: list[str] = []
    meta: dict = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            buf = b""
            for chunk in resp:
                buf += chunk
                while b"\n\n" in buf:
                    raw_evt, buf = buf.split(b"\n\n", 1)
                    for line in raw_evt.split(b"\n"):
                        if not line.startswith(b"data:"):
                            continue
                        payload_s = line[5:].strip()
                        if not payload_s or payload_s == b"[DONE]":
                            continue
                        try:
                            evt = json.loads(payload_s)
                        except json.JSONDecodeError:
                            continue
                        ev_type = evt.get("event")
                        if ev_type in ("message", "agent_message"):
                            ans = evt.get("answer")
                            if isinstance(ans, str):
                                answer_parts.append(ans)
                        elif ev_type == "message_end":
                            md = evt.get("metadata")
                            if isinstance(md, dict):
                                meta.update(md)
                        elif ev_type == "cloud_response_meta":
                            meta["cloud_provider"] = evt.get("provider")
                            meta["cloud_model"] = evt.get("model")
    except urllib.error.HTTPError as e:
        # Retry sur 5xx (panne API, rate-limit transient). On laisse passer
        # 4xx (bad request, auth) — pas la peine de retry.
        if 500 <= e.code < 600 and retries > 0:
            time.sleep(2 * (3 - retries))  # backoff progressif 2s, 4s
            return _post_sse(url, body, cookie, timeout_s, retries - 1)
        return f"[HTTP_ERROR_{e.code}: {e.reason}]", {"error": True, "status": e.code}
    except urllib.error.URLError as e:
        if retries > 0:
            time.sleep(2)
            return _post_sse(url, body, cookie, timeout_s, retries - 1)
        return f"[URL_ERROR: {e.reason}]", {"error": True}
    except TimeoutError:
        return "[TIMEOUT]", {"error": True, "timeout": True}
    except Exception as e:
        return f"[EXCEPTION: {type(e).__name__}: {e}]", {"error": True}

    return "".join(answer_parts), meta


# ---- Backends -------------------------------------------------------------


def call_local(base_url: str, cookie: str, prompt: dict) -> dict:
    """Appel /api/chat (agent local Dify)."""
    body: dict[str, Any] = {
        "agent": prompt.get("agent", "general"),
        "query": prompt["prompt"],
    }
    t0 = time.time()
    answer, meta = _post_sse(
        f"{base_url}/api/chat",
        body,
        cookie,
        prompt.get("timeout_s", 60),
    )
    elapsed = time.time() - t0
    return {
        "backend": "local",
        "elapsed_s": round(elapsed, 2),
        "answer": answer,
        "answer_len": len(answer),
        "meta": meta,
    }


# Cache pre-prompts (récupérés une fois par agent slug)
_AGENT_PREPROMPT_CACHE: dict[str, str] = {}


def _get_agent_preprompt(base_url: str, cookie: str, agent_slug: str) -> str:
    """Récupère le pre-prompt de l'agent depuis /api/agents/<slug>.
    Cache en mémoire pour éviter de re-fetch à chaque prompt.

    Permet d'envoyer au cloud le MÊME contexte (pre_prompt) que le local.
    Sans ça, le cloud ne sait pas qu'il doit utiliser [FILE:nom.ext]...
    [/FILE], n'a pas les RÉFÉRENCES FISCALES 2026, etc. → bench unfair.
    """
    if agent_slug in _AGENT_PREPROMPT_CACHE:
        return _AGENT_PREPROMPT_CACHE[agent_slug]
    try:
        req = urllib.request.Request(
            f"{base_url}/api/agents/{urllib.parse.quote(agent_slug)}",
            headers={"Cookie": cookie, "Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        pp = data.get("pre_prompt") or ""
    except Exception:
        pp = ""
    _AGENT_PREPROMPT_CACHE[agent_slug] = pp
    return pp


def call_cloud(
    base_url: str,
    cookie: str,
    prompt: dict,
    provider: str,
    model: str,
    inject_preprompt: bool = True,
) -> dict:
    """Appel /api/chat-cloud (provider direct).

    Si inject_preprompt=True (défaut), récupère le pre_prompt de l'agent
    et le prépose au query → le cloud reçoit le MÊME contexte que le
    local (FILE-RULE-V2, RÉFÉRENCES FISCALES 2026, etc.). Sinon le bench
    est unfair (le local connaît les conventions BoxIA, le cloud non).

    Si la réponse contient HTTP_ERROR_5xx, fallback automatique sur
    FALLBACK_PROVIDER (Google Gemini par défaut). Le score reflète alors
    la VRAIE qualité cloud disponible (pas un fail provider transient).
    """
    agent_slug = prompt.get("agent", "general")
    user_query = prompt["prompt"]
    if inject_preprompt:
        pp = _get_agent_preprompt(base_url, cookie, agent_slug)
        if pp:
            user_query = (
                "[Contexte agent — instructions système]\n"
                + pp
                + "\n\n[Demande utilisateur]\n"
                + prompt["prompt"]
            )
    body: dict[str, Any] = {
        "agent": agent_slug,
        "query": user_query,
        "provider": provider,
        "model": model,
        "pii_scrub_enabled": True,
    }
    t0 = time.time()
    answer, meta = _post_sse(
        f"{base_url}/api/chat-cloud",
        body,
        cookie,
        prompt.get("timeout_s", 60),
    )
    elapsed = time.time() - t0
    # Fallback automatique si HTTP 5xx ou network error
    if (
        "[HTTP_ERROR_5" in answer
        or "[URL_ERROR" in answer
        or "[EXCEPTION" in answer
    ) and provider != FALLBACK_PROVIDER:
        body["provider"] = FALLBACK_PROVIDER
        body["model"] = FALLBACK_MODEL
        meta["fallback_from"] = f"{provider}/{model}"
        meta["fallback_to"] = f"{FALLBACK_PROVIDER}/{FALLBACK_MODEL}"
        t0 = time.time()
        answer, meta2 = _post_sse(
            f"{base_url}/api/chat-cloud",
            body,
            cookie,
            prompt.get("timeout_s", 60),
        )
        elapsed = time.time() - t0
        meta.update(meta2)
    return {
        "backend": "cloud",
        "elapsed_s": round(elapsed, 2),
        "answer": answer,
        "answer_len": len(answer),
        "meta": meta,
    }


# ---- Driver ---------------------------------------------------------------


def run_prompt(prompt: dict, base_url: str, cookie: str, args) -> dict:
    """Exécute un prompt sur local + cloud, score les 2."""
    pid = prompt["id"]
    print(f"\n▶ {pid} [{prompt['category']}/{prompt.get('agent','?')}]", flush=True)

    if prompt.get("skip_reason"):
        print(f"  ⏭  skip: {prompt['skip_reason']}")
        return {
            "prompt_id": pid,
            "category": prompt["category"],
            "agent": prompt.get("agent"),
            "skipped": True,
            "skip_reason": prompt["skip_reason"],
            "local": None,
            "cloud": None,
        }

    out = {
        "prompt_id": pid,
        "category": prompt["category"],
        "agent": prompt.get("agent"),
        "prompt_excerpt": prompt["prompt"][:150],
        "skipped": False,
        "cloud_na_reason": prompt.get("cloud_na"),  # exposé pour l'UI/CSV
        "local": None,
        "cloud": None,
    }

    scorers = prompt.get("scorers") or []
    cloud_na = bool(prompt.get("cloud_na"))

    # LOCAL
    if not args.skip_local:
        local = call_local(base_url, cookie, prompt)
        local_score = score_response(local["answer"], scorers)
        local["score"] = local_score
        out["local"] = local
        print(
            f"  local : {local['elapsed_s']:>5.1f}s · {local['answer_len']:>4} chars · "
            f"{local_score['score_pct']:>5.1f}% ({local_score['passed_count']}/{local_score['total_count']})"
        )

    # CLOUD — skip si cloud_na (test structurellement non comparable)
    if cloud_na and not args.skip_cloud:
        print(f"  cloud : N/A — {prompt['cloud_na']}")
    elif not args.skip_cloud:
        cloud = call_cloud(base_url, cookie, prompt, args.cloud_provider, args.cloud_model)
        cloud_score = score_response(cloud["answer"], scorers)
        cloud["score"] = cloud_score
        out["cloud"] = cloud
        fb = cloud.get("meta", {}).get("fallback_to")
        fb_str = f" [fallback→{fb}]" if fb else ""
        print(
            f"  cloud{fb_str} : {cloud['elapsed_s']:>5.1f}s · {cloud['answer_len']:>4} chars · "
            f"{cloud_score['score_pct']:>5.1f}% ({cloud_score['passed_count']}/{cloud_score['total_count']})"
        )

    return out


def filter_prompts(prompts: list[dict], args) -> list[dict]:
    out = prompts
    if args.category:
        out = [p for p in out if p["category"] == args.category]
    if args.prompt_id:
        out = [p for p in out if p["id"] == args.prompt_id]
    if args.agent:
        out = [p for p in out if p.get("agent") == args.agent]
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default=DEFAULT_BASE_URL,
                   help=f"URL de base de l'app (default: {DEFAULT_BASE_URL})")
    p.add_argument("--cookie", default=os.environ.get("BENCH_COOKIE", ""),
                   help="Cookie de session NextAuth (ou via env BENCH_COOKIE)")
    p.add_argument("--cloud-provider", default=DEFAULT_CLOUD_PROVIDER,
                   choices=["openai", "anthropic", "google", "mistral"])
    p.add_argument("--cloud-model", default=DEFAULT_CLOUD_MODEL)
    p.add_argument("--category", help="Filtre une seule catégorie")
    p.add_argument("--prompt-id", help="Lance un seul prompt par id")
    p.add_argument("--agent", help="Filtre par agent slug")
    p.add_argument("--skip-cloud", action="store_true", help="Skip les appels cloud")
    p.add_argument("--skip-local", action="store_true", help="Skip les appels locaux")
    p.add_argument("--dry-run", action="store_true", help="Liste les prompts sans exécuter")
    p.add_argument("--prompts-file", default=str(HERE / "prompts.json"))
    p.add_argument("--out-dir", default=None,
                   help="Dossier de sortie (default: tools/bench/runs/<timestamp>/)")
    args = p.parse_args()

    if not args.cookie and not args.dry_run:
        print("✗ Cookie de session manquant. Pass --cookie ou export BENCH_COOKIE.", file=sys.stderr)
        return 2

    catalog = json.loads(Path(args.prompts_file).read_text(encoding="utf-8"))
    prompts = filter_prompts(catalog["prompts"], args)
    if not prompts:
        print("✗ Aucun prompt ne match les filtres", file=sys.stderr)
        return 2

    print(f"Bench AI Box — {len(prompts)} prompt(s) à exécuter")
    print(f"  Base URL : {args.base_url}")
    print(f"  Local    : {'skip' if args.skip_local else 'on'}")
    print(f"  Cloud    : {'skip' if args.skip_cloud else f'{args.cloud_provider}/{args.cloud_model}'}")

    if args.dry_run:
        print("\n— DRY RUN — liste des prompts :")
        for prompt in prompts:
            tag = " [SKIP]" if prompt.get("skip_reason") else ""
            print(f"  {prompt['id']:30}  {prompt['category']:12}  {prompt.get('agent','?'):12}{tag}")
        return 0

    # Output dir
    if args.out_dir:
        out_dir = Path(args.out_dir)
    else:
        ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        out_dir = HERE / "runs" / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(exist_ok=True)
    print(f"  Sortie   : {out_dir}\n")

    results: list[dict] = []
    bench_t0 = time.time()
    for i, prompt in enumerate(prompts, 1):
        print(f"[{i}/{len(prompts)}]", end=" ", flush=True)
        try:
            r = run_prompt(prompt, args.base_url, args.cookie, args)
        except KeyboardInterrupt:
            print("\n⚠ interrompu (Ctrl-C) — sauvegarde des résultats partiels…")
            break
        results.append(r)
        # Dump raw par prompt
        for backend in ("local", "cloud"):
            data = r.get(backend)
            if data:
                (raw_dir / f"{prompt['id']}.{backend}.json").write_text(
                    json.dumps(data, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )

    bench_elapsed = time.time() - bench_t0

    # Save aggregate
    summary = _build_summary(results)
    summary["meta"] = {
        "generated_at": dt.datetime.now().isoformat(),
        "base_url": args.base_url,
        "cloud_provider": args.cloud_provider,
        "cloud_model": args.cloud_model,
        "elapsed_s": round(bench_elapsed, 1),
        "n_prompts": len(prompts),
        "n_executed": len(results),
    }

    (out_dir / "results.json").write_text(
        json.dumps({"results": results, "summary": summary}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _write_csv(out_dir / "results.csv", results)
    try:
        from report import render_html  # noqa: WPS433
        html = render_html(results, summary)
        (out_dir / "report.html").write_text(html, encoding="utf-8")
        print(f"\n✓ Rapport HTML : {out_dir / 'report.html'}")
    except Exception as e:
        print(f"\n⚠ Génération HTML échec : {e}", file=sys.stderr)

    print(f"\n=== Bilan ({bench_elapsed:.0f}s) ===")
    print(f"  Local moyen : {summary['local_avg_score']:.1f}% ({summary['local_avg_latency_s']:.1f}s)")
    print(f"  Cloud moyen : {summary['cloud_avg_score']:.1f}% ({summary['cloud_avg_latency_s']:.1f}s)")
    print(f"  Ratio local/cloud : {summary['ratio_local_over_cloud']:.0%}")
    print(f"\nFichiers : {out_dir}")
    return 0


def _build_summary(results: list[dict]) -> dict:
    def avg(values):
        vs = [v for v in values if v is not None]
        return sum(vs) / len(vs) if vs else 0.0

    local_scores = [r["local"]["score"]["score_pct"] for r in results if r.get("local")]
    cloud_scores = [r["cloud"]["score"]["score_pct"] for r in results if r.get("cloud")]
    local_lats = [r["local"]["elapsed_s"] for r in results if r.get("local")]
    cloud_lats = [r["cloud"]["elapsed_s"] for r in results if r.get("cloud")]

    local_avg = avg(local_scores)
    cloud_avg = avg(cloud_scores)

    # Per-category
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

    return {
        "local_avg_score": round(local_avg, 1),
        "cloud_avg_score": round(cloud_avg, 1),
        "local_avg_latency_s": round(avg(local_lats), 1),
        "cloud_avg_latency_s": round(avg(cloud_lats), 1),
        "ratio_local_over_cloud": (local_avg / cloud_avg) if cloud_avg > 0 else 0.0,
        "n_skipped": sum(1 for r in results if r.get("skipped")),
        "by_category": cat_summary,
    }


def _write_csv(path: Path, results: list[dict]) -> None:
    cols = [
        "prompt_id", "category", "agent",
        "local_score", "local_latency_s", "local_chars",
        "cloud_score", "cloud_latency_s", "cloud_chars",
        "delta_score", "skipped",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in results:
            ls = r["local"]["score"]["score_pct"] if r.get("local") else None
            cs = r["cloud"]["score"]["score_pct"] if r.get("cloud") else None
            w.writerow([
                r["prompt_id"],
                r["category"],
                r.get("agent") or "",
                ls if ls is not None else "",
                r["local"]["elapsed_s"] if r.get("local") else "",
                r["local"]["answer_len"] if r.get("local") else "",
                cs if cs is not None else "",
                r["cloud"]["elapsed_s"] if r.get("cloud") else "",
                r["cloud"]["answer_len"] if r.get("cloud") else "",
                (ls - cs) if (ls is not None and cs is not None) else "",
                "yes" if r.get("skipped") else "no",
            ])


if __name__ == "__main__":
    sys.exit(main())
