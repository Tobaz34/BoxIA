"""AI Box Cookbook — CLI : scanne le hardware, recommande (et installe) le modèle local.

  python cookbook.py                      # scan + reco
  python cookbook.py --ram 32 --vram 12   # forcer le hardware (démo/test)
  python cookbook.py --prefer speed
  python cookbook.py --pull               # ollama pull du modèle recommandé
  python cookbook.py --json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

import recommend
import scan


def main() -> None:
    try:  # console Windows (cp1252) : forcer l'UTF-8 pour les accents/flèches
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="AI Box Cookbook — modèle local recommandé")
    ap.add_argument("--ram", type=float, default=None, help="RAM Go (sinon auto-détecté)")
    ap.add_argument("--vram", type=float, default=None, help="VRAM GPU Go (sinon auto-détecté)")
    ap.add_argument("--prefer", choices=["quality", "speed"], default="quality")
    ap.add_argument("--pull", action="store_true", help="ollama pull du modèle recommandé")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    ram = a.ram if a.ram is not None else scan.detect_ram_gb()
    vram = a.vram if a.vram is not None else scan.detect_vram_gb()
    r = recommend.recommend(ram, vram, a.prefer)
    r["ram_gb"] = round(ram, 1)
    r["vram_gb"] = round(vram, 1)

    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(f"Hardware    : {ram:.0f} Go RAM | {vram:.0f} Go VRAM")
        print(f"Recommandé  : {r['recommended']}  (qualité FR {r.get('fr_quality', '?')}/5)")
        print(f"Raison      : {r['reason']}")
        if r.get("alternatives"):
            print(f"Alternatives: {', '.join(r['alternatives'])}")

    if a.pull:
        print(f"... ollama pull {r['recommended']}")
        subprocess.run(["ollama", "pull", r["recommended"]], check=False)


if __name__ == "__main__":
    main()
