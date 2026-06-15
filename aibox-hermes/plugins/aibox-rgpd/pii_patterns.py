"""Patterns PII français — port de services/app/src/lib/pii-scrub.ts.

ORDRE CRITIQUE (du plus spécifique au plus générique) :
  iban → email → credit_card → nir → siret → siren → phone

Sinon un pattern court (phone_fr) grignote l'intérieur d'un pattern long
(IBAN). Bug historique documenté dans le sprint « Standard 2026 » de BoxIA :
sans ce ré-ordonnancement, « FR76 3000 6000 0112 3456 7890 189 » se faisait
découper en « FR76 3000 6000 [PHONE]90 189 ».

Limite assumée (comme l'original) : best-effort, pas de NER → ne détecte pas
les noms propres (« Jean Dupont »).
"""
from __future__ import annotations

import re
from typing import NamedTuple


class _Pattern(NamedTuple):
    name: str
    regex: "re.Pattern[str]"
    replacement: str


PATTERNS: list[_Pattern] = [
    # IBAN d'abord, sinon phone_fr grignote son intérieur.
    _Pattern(
        "iban",
        re.compile(r"\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){4,7}[A-Z0-9]{1,4}\b"),
        "[IBAN_REDACTED]",
    ),
    # Email avant les patterns numériques (un email peut contenir 9+ chiffres).
    _Pattern(
        "email",
        re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
        "[EMAIL_REDACTED]",
    ),
    _Pattern(
        "credit_card",
        re.compile(r"\b(?:\d{4}[\s-]?){3}\d{4}\b"),
        "[CARD_REDACTED]",
    ),
    # NIR (sécu sociale) commence par 1 ou 2 → avant siret (14 chiffres bruts).
    _Pattern(
        "nir_fr",
        re.compile(r"\b[12]\s?\d{2}\s?\d{2}\s?\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2}\b"),
        "[NIR_REDACTED]",
    ),
    _Pattern(
        "siret",
        re.compile(r"\b\d{3}[\s]?\d{3}[\s]?\d{3}[\s]?\d{5}\b"),
        "[SIRET_REDACTED]",
    ),
    _Pattern(
        "siren",
        re.compile(r"\b\d{3}[\s]?\d{3}[\s]?\d{3}\b(?!\d)"),
        "[SIREN_REDACTED]",
    ),
    # phone_fr EN DERNIER : le plus permissif.
    _Pattern(
        "phone_fr",
        re.compile(r"(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}"),
        "[PHONE_REDACTED]",
    ),
]


def scrub_pii(text: str) -> tuple[str, int, dict[str, int]]:
    """Caviarde la PII française. Retourne (texte_caviardé, total, par_type)."""
    if not text:
        return text, 0, {}
    out = text
    by_type: dict[str, int] = {}
    for p in PATTERNS:
        out, n = p.regex.subn(p.replacement, out)
        if n:
            by_type[p.name] = n
    return out, sum(by_type.values()), by_type
