"""Scorers déterministes pour le bench AI Box.

Pas de LLM-as-judge — chaque scorer est une règle objective et reproductible.
Utiliser un LLM pour scorer les réponses biaiserait fortement le bench (le
juge favorise son propre style). Pour les tests vraiment subjectifs (qualité
rédactionnelle), prévoir une review humaine séparée.

Chaque scorer prend (response_text, scorer_config) et retourne :
  {
    "passed": bool,
    "weight": float (1.0 par défaut),
    "details": str (pourquoi passed/failed),
  }

Score final d'un prompt = somme des `weight` des scorers passed / somme totale.
"""
from __future__ import annotations

import re
from typing import Any


# ---- Scorers individuels --------------------------------------------------


def _score_numeric_present(text: str, cfg: dict) -> dict:
    """Vérifie qu'un chiffre exact (ou dans une plage) est présent dans la
    réponse. Tolère les séparateurs FR (espaces, virgules) et la notation
    "1 234,56" ou "1,234.56"."""
    target = cfg.get("value")
    tolerance = float(cfg.get("tolerance", 0))
    min_val = cfg.get("min")
    max_val = cfg.get("max")

    # Extrait tous les nombres du texte (FR + EN)
    # Patterns : 1234.56, 1234,56, 1 234,56, 1,234.56, 1234
    nums: list[float] = []
    pattern = re.compile(r"-?\d{1,3}(?:[\s ,.]\d{3})*(?:[,.]\d+)?|-?\d+(?:[,.]\d+)?")
    for m in pattern.finditer(text):
        raw = m.group()
        # Normalise : enlève les espaces de millier, convertit virgule
        # décimale en point. Heuristique : si on a à la fois , et ., le
        # dernier symbole est le séparateur décimal.
        s = raw.replace(" ", "").replace(" ", "")
        if "," in s and "." in s:
            if s.rfind(",") > s.rfind("."):
                s = s.replace(".", "").replace(",", ".")
            else:
                s = s.replace(",", "")
        elif "," in s:
            # Si plusieurs virgules → séparateurs de milliers EN-style
            if s.count(",") > 1:
                s = s.replace(",", "")
            else:
                # 1 seule virgule : décimale FR
                s = s.replace(",", ".")
        try:
            nums.append(float(s))
        except ValueError:
            pass

    if target is not None:
        ok = any(abs(n - target) <= tolerance for n in nums)
        return {
            "passed": ok,
            "weight": 1.0,
            "details": f"target {target} (±{tolerance}) {'trouvé' if ok else 'absent'} dans {len(nums)} nombres extraits",
        }
    if min_val is not None or max_val is not None:
        lo = float(min_val) if min_val is not None else float("-inf")
        hi = float(max_val) if max_val is not None else float("inf")
        ok = any(lo <= n <= hi for n in nums)
        return {
            "passed": ok,
            "weight": 1.0,
            "details": f"valeur dans [{lo},{hi}] {'trouvée' if ok else 'absente'}",
        }
    return {"passed": False, "weight": 1.0, "details": "scorer mal configuré"}


def _score_regex_match(text: str, cfg: dict) -> dict:
    """Vérifie qu'au moins un des patterns regex est présent dans la
    réponse (case-insensitive). Si plusieurs patterns dans la liste, OR
    logique."""
    patterns = cfg.get("patterns") or []
    if not patterns:
        return {"passed": False, "weight": 1.0, "details": "patterns vides"}
    found: list[str] = []
    for pat in patterns:
        if re.search(pat, text, flags=re.IGNORECASE | re.MULTILINE):
            found.append(pat)
    ok = len(found) > 0
    return {
        "passed": ok,
        "weight": 1.0,
        "details": f"{len(found)}/{len(patterns)} patterns matchés ({found if ok else 'aucun'})",
    }


def _score_no_refusal(text: str, cfg: dict) -> dict:
    """Vérifie l'absence de marqueurs de refus injustifié. Inverse de
    regex_match : passe si AUCUN pattern n'est trouvé."""
    patterns = cfg.get("patterns") or []
    if not patterns:
        return {"passed": True, "weight": 1.0, "details": "pas de patterns à éviter"}
    triggered: list[str] = []
    for pat in patterns:
        if re.search(pat, text, flags=re.IGNORECASE | re.MULTILINE):
            triggered.append(pat)
    ok = len(triggered) == 0
    return {
        "passed": ok,
        "weight": 1.5,  # Plus pondéré : un refus injustifié pénalise plus
        "details": (
            "aucun marqueur de refus"
            if ok
            else f"refus détecté : {triggered}"
        ),
    }


def _score_min_length(text: str, cfg: dict) -> dict:
    """Réponse minimale acceptée (en chars)."""
    n = int(cfg.get("value", 0))
    actual = len(text.strip())
    ok = actual >= n
    return {
        "passed": ok,
        "weight": 0.5,
        "details": f"{actual} chars (min {n})",
    }


def _score_max_lines(text: str, cfg: dict) -> dict:
    """Réponse ne dépasse pas N lignes (contrainte de format)."""
    n = int(cfg.get("value", 0))
    lines = [l for l in text.splitlines() if l.strip()]
    ok = len(lines) <= n
    return {
        "passed": ok,
        "weight": 0.5,
        "details": f"{len(lines)} lignes non-vides (max {n})",
    }


def _score_max_tokens_response(text: str, cfg: dict) -> dict:
    """Approxime un check de taille — pour Q vagues qui devraient avoir
    réponses courtes. 1 token ≈ 4 chars pour FR."""
    n = int(cfg.get("value", 0))
    approx_tokens = len(text) // 4
    ok = approx_tokens <= n
    return {
        "passed": ok,
        "weight": 0.5,
        "details": f"~{approx_tokens} tokens (max {n})",
    }


def _score_file_marker_present(text: str, cfg: dict) -> dict:
    """Vérifie qu'un marker de fichier généré est présent dans la réponse.
    Pattern attendu (cf. lib/chat-stream-files.ts) :
      {{file:UUID:nom:size:mime}}
    Ou plus permissif : nom de fichier matchant filename_regex."""
    name_re = cfg.get("filename_regex", r".+\..+")
    # Marker complet
    full = re.search(r"\{\{file:[^:]+:([^:]+):", text)
    if full:
        fname = full.group(1)
        ok = bool(re.search(name_re, fname, flags=re.IGNORECASE))
        return {
            "passed": ok,
            "weight": 1.5,
            "details": f"marker présent fichier='{fname}', match='{name_re}'={ok}",
        }
    # Fallback : nom de fichier simple dans le texte
    if re.search(name_re, text, flags=re.IGNORECASE):
        return {
            "passed": True,
            "weight": 0.7,  # Moins pondéré car pas de vrai marker
            "details": f"nom de fichier mentionné mais pas de marker {{...}}",
        }
    return {
        "passed": False,
        "weight": 1.5,
        "details": f"aucun marker de fichier ni nom matchant '{name_re}'",
    }


def _score_min_file_size_kb(text: str, cfg: dict) -> dict:
    """Vérifie qu'un fichier généré dépasse une taille minimum.
    Lit la taille depuis le marker {{file:UUID:nom:SIZE_BYTES:mime}}."""
    n_kb = float(cfg.get("value", 0))
    m = re.search(r"\{\{file:[^:]+:[^:]+:(\d+):", text)
    if not m:
        return {
            "passed": False,
            "weight": 0.5,
            "details": "pas de marker fichier (taille indisponible)",
        }
    size_kb = int(m.group(1)) / 1024
    ok = size_kb >= n_kb
    return {
        "passed": ok,
        "weight": 0.5,
        "details": f"{size_kb:.1f} Ko (min {n_kb} Ko)",
    }


# ---- Dispatch -------------------------------------------------------------

SCORERS: dict[str, Any] = {
    "numeric_present": _score_numeric_present,
    "regex_match": _score_regex_match,
    "no_refusal": _score_no_refusal,
    "min_length": _score_min_length,
    "max_lines": _score_max_lines,
    "max_tokens_response": _score_max_tokens_response,
    "file_marker_present": _score_file_marker_present,
    "min_file_size_kb": _score_min_file_size_kb,
}


def score_response(response_text: str, scorers_cfg: list[dict]) -> dict:
    """Évalue une réponse contre la liste de scorers configurés.

    Retourne :
      {
        "score_pct": float,    # 0-100
        "passed_count": int,
        "total_count": int,
        "details": [ {scorer_type, passed, weight, details}, ... ],
      }
    """
    results: list[dict] = []
    total_weight = 0.0
    passed_weight = 0.0

    for cfg in scorers_cfg:
        scorer_type = cfg.get("type")
        fn = SCORERS.get(scorer_type)
        if fn is None:
            results.append(
                {
                    "scorer_type": scorer_type,
                    "passed": False,
                    "weight": 1.0,
                    "details": f"scorer inconnu: {scorer_type}",
                }
            )
            total_weight += 1.0
            continue
        out = fn(response_text or "", cfg)
        out["scorer_type"] = scorer_type
        results.append(out)
        total_weight += out["weight"]
        if out["passed"]:
            passed_weight += out["weight"]

    score_pct = (passed_weight / total_weight * 100.0) if total_weight > 0 else 0.0
    passed_count = sum(1 for r in results if r["passed"])
    return {
        "score_pct": round(score_pct, 1),
        "passed_count": passed_count,
        "total_count": len(results),
        "details": results,
    }


if __name__ == "__main__":
    # Mini self-test
    text = "Le total des crédits est 7 340 €, débits 5 009,40 €, solde +2 330,60 €."
    cfg = [
        {"type": "numeric_present", "value": 7340, "tolerance": 1},
        {"type": "numeric_present", "value": 5009.40, "tolerance": 0.5},
        {"type": "numeric_present", "value": 2330.60, "tolerance": 0.5},
        {"type": "no_refusal", "patterns": ["je n'ai pas les données"]},
    ]
    import json
    print(json.dumps(score_response(text, cfg), indent=2, ensure_ascii=False))
