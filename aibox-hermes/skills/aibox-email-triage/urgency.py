"""Scoring d'urgence d'un email (déterministe, FR) — pur & testable.

Donne un signal stable AVANT l'analyse LLM (le modèle peut sous/sur-estimer).
Idée du « AI triage » d'Odysseus, adaptée au contexte TPE/PME français.
"""
from __future__ import annotations

from typing import Optional

# Signaux forts (+3) : risque juridique / financier immédiat.
_HIGH = [
    "mise en demeure", "huissier", "contentieux", "dernière relance",
    "derniere relance", "résiliation", "resiliation", "injonction",
]
# Signaux moyens (+2).
_MED = [
    "urgent", "relance", "impayé", "impaye", "retard", "délai", "delai",
    "deadline", "rappel", "échéance", "echeance", "facture en souffrance",
]
# Signaux de délai court (+1).
_LOW = [
    "aujourd'hui", "aujourdhui", "avant ce soir", "asap", "au plus vite",
    "dès que possible", "des que possible", "réponse attendue", "reponse attendue",
]


def score_urgency(
    subject: str = "", body: str = "", sender: str = "", vips: Optional[list[str]] = None
) -> dict:
    """Retourne {level: haute|moyenne|basse, score, reasons}."""
    text = f"{subject}\n{body}".lower()
    vips_l = [v.lower() for v in (vips or [])]
    score = 0
    high_hit = False
    reasons: list[str] = []
    for kw in _HIGH:
        if kw in text:
            score += 3
            high_hit = True
            reasons.append(f"signal fort: {kw}")
    for kw in _MED:
        if kw in text:
            score += 2
            reasons.append(f"signal: {kw}")
    for kw in _LOW:
        if kw in text:
            score += 1
            reasons.append(f"délai court: {kw}")
    if sender and any(v in sender.lower() for v in vips_l):
        score += 2
        reasons.append("expéditeur prioritaire (VIP)")
    # Un seul signal fort (mise en demeure, huissier…) suffit à classer en haute.
    level = "haute" if (high_hit or score >= 4) else ("moyenne" if score >= 2 else "basse")
    return {"level": level, "score": score, "reasons": reasons}
