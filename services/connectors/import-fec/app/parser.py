"""Parser FEC strictly conforme à l'article A. 47 A-1 du Livre des Procédures Fiscales.

Le FEC est obligatoire pour toute entreprise française en comptabilité informatisée
(seuils art. L. 13 LPF). Format légal : 18 colonnes, séparateur tabulation par défaut
(parfois pipe `|`), encoding ASCII étendu (Latin-1) ou UTF-8.

Colonnes obligatoires (ordre fixe par la loi) :
 1. JournalCode
 2. JournalLib
 3. EcritureNum
 4. EcritureDate           (YYYYMMDD)
 5. CompteNum
 6. CompteLib
 7. CompAuxNum
 8. CompAuxLib
 9. PieceRef
10. PieceDate              (YYYYMMDD)
11. EcritureLib
12. Debit                  (montant, virgule ou point)
13. Credit
14. EcritureLet            (lettrage)
15. DateLet                (YYYYMMDD)
16. ValidDate              (YYYYMMDD)
17. Montantdevise
18. Idevise

Référence officielle :
- BOI-CF-IOR-60-40-20-20131213 (Bulletin Officiel des Finances Publiques)
- arrêté du 29 juillet 2013, JORF n°0177 du 1er août 2013
"""
from __future__ import annotations

import csv
import io
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import IO, Iterable

logger = logging.getLogger(__name__)


# Ordre canonique imposé par la loi
FEC_COLUMNS: list[str] = [
    "JournalCode", "JournalLib",
    "EcritureNum", "EcritureDate",
    "CompteNum", "CompteLib",
    "CompAuxNum", "CompAuxLib",
    "PieceRef", "PieceDate",
    "EcritureLib",
    "Debit", "Credit",
    "EcritureLet", "DateLet",
    "ValidDate",
    "Montantdevise", "Idevise",
]


@dataclass
class FECEntry:
    """Une écriture comptable FEC normalisée."""
    journal_code: str
    journal_lib: str
    ecriture_num: str
    ecriture_date: date
    compte_num: str
    compte_lib: str
    comp_aux_num: str | None
    comp_aux_lib: str | None
    piece_ref: str | None
    piece_date: date | None
    ecriture_lib: str
    debit: Decimal
    credit: Decimal
    ecriture_let: str | None
    date_let: date | None
    valid_date: date | None
    montant_devise: Decimal | None
    idevise: str | None
    line_number: int  # numéro de ligne dans le fichier (debug)


@dataclass
class FECParseReport:
    """Rapport de parsing : statistiques + erreurs structurées."""
    file_size_bytes: int
    encoding_detected: str
    delimiter: str
    header_columns: list[str]
    total_lines: int
    parsed_entries: int
    skipped_lines: int
    errors: list[dict] = field(default_factory=list)  # [{line, reason, raw}]
    journals: Counter = field(default_factory=Counter)
    comptes: Counter = field(default_factory=Counter)
    period_min: date | None = None
    period_max: date | None = None
    total_debit: Decimal = Decimal("0")
    total_credit: Decimal = Decimal("0")
    is_balanced: bool = False     # Σdebit == Σcredit (à 0.01€ près)
    columns_match_legal: bool = False


class FECParseError(Exception):
    pass


def _detect_encoding(blob: bytes) -> str:
    """FEC officiel = ASCII Latin-1 ou UTF-8. On teste UTF-8 d'abord (plus strict)."""
    for enc in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            blob.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    raise FECParseError("Encodage indétectable (ni UTF-8 ni Latin-1 ni CP1252)")


def _detect_delimiter(first_line: str) -> str:
    """FEC officiel = TAB. Certains éditeurs (Sage notamment) exportent en pipe `|`."""
    candidates = [("\t", first_line.count("\t")), ("|", first_line.count("|")), (";", first_line.count(";"))]
    candidates.sort(key=lambda x: x[1], reverse=True)
    if candidates[0][1] < 5:  # un FEC a 18 colonnes → minimum 17 séparateurs
        raise FECParseError(f"Séparateur introuvable. Premiers chars: {first_line[:200]!r}")
    return candidates[0][0]


def _parse_amount(s: str) -> Decimal:
    """FEC peut utiliser virgule OU point. Vide = 0. Espaces ignorés (séparateur milliers)."""
    if s is None:
        return Decimal("0")
    s = s.strip().replace(" ", "").replace(" ", "")
    if not s:
        return Decimal("0")
    s = s.replace(",", ".")
    try:
        return Decimal(s)
    except InvalidOperation as e:
        raise FECParseError(f"Montant invalide : {s!r}") from e


def _parse_date(s: str) -> date | None:
    """Format légal : YYYYMMDD. Tolère YYYY-MM-DD pour exports laxistes."""
    if not s or s.strip() == "":
        return None
    s = s.strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise FECParseError(f"Date invalide : {s!r} (attendu YYYYMMDD)")


def parse_fec_stream(
    stream: IO[bytes],
    max_size_bytes: int = 100 * 1024 * 1024,
    strict: bool = False,
) -> tuple[list[FECEntry], FECParseReport]:
    """Parse un FEC en streaming. `strict=True` lève à la première anomalie ;
    sinon on accumule les erreurs dans le report et on continue.
    """
    blob = stream.read(max_size_bytes + 1)
    if len(blob) > max_size_bytes:
        raise FECParseError(
            f"Fichier > {max_size_bytes / 1024 / 1024:.0f} Mo (limite configurée)"
        )

    encoding = _detect_encoding(blob)
    text = blob.decode(encoding)
    if text.startswith("﻿"):
        text = text[1:]

    lines = text.splitlines()
    if not lines:
        raise FECParseError("Fichier vide")

    delimiter = _detect_delimiter(lines[0])
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)

    header = next(reader)
    header_clean = [h.strip().lstrip("﻿") for h in header]
    cols_match = (header_clean == FEC_COLUMNS)
    if not cols_match and strict:
        raise FECParseError(
            f"Header non conforme. Attendu : {FEC_COLUMNS}\nReçu : {header_clean}"
        )

    # Map index → position dans header (tolère colonnes manquantes/réordonnées si non strict)
    col_idx = {col: header_clean.index(col) for col in FEC_COLUMNS if col in header_clean}
    required = ["JournalCode", "EcritureNum", "EcritureDate", "CompteNum",
                "EcritureLib", "Debit", "Credit"]
    missing = [c for c in required if c not in col_idx]
    if missing:
        raise FECParseError(f"Colonnes obligatoires manquantes : {missing}")

    report = FECParseReport(
        file_size_bytes=len(blob),
        encoding_detected=encoding,
        delimiter=delimiter,
        header_columns=header_clean,
        total_lines=0,
        parsed_entries=0,
        skipped_lines=0,
        columns_match_legal=cols_match,
    )

    entries: list[FECEntry] = []

    def _g(row: list[str], col: str, default: str = "") -> str:
        idx = col_idx.get(col)
        if idx is None or idx >= len(row):
            return default
        return row[idx]

    for line_num, row in enumerate(reader, start=2):
        report.total_lines += 1
        if not row or all(c.strip() == "" for c in row):
            report.skipped_lines += 1
            continue

        try:
            ecr_date = _parse_date(_g(row, "EcritureDate"))
            if ecr_date is None:
                raise FECParseError("EcritureDate vide (obligatoire)")

            entry = FECEntry(
                journal_code=_g(row, "JournalCode").strip(),
                journal_lib=_g(row, "JournalLib").strip(),
                ecriture_num=_g(row, "EcritureNum").strip(),
                ecriture_date=ecr_date,
                compte_num=_g(row, "CompteNum").strip(),
                compte_lib=_g(row, "CompteLib").strip(),
                comp_aux_num=_g(row, "CompAuxNum").strip() or None,
                comp_aux_lib=_g(row, "CompAuxLib").strip() or None,
                piece_ref=_g(row, "PieceRef").strip() or None,
                piece_date=_parse_date(_g(row, "PieceDate")),
                ecriture_lib=_g(row, "EcritureLib").strip(),
                debit=_parse_amount(_g(row, "Debit")),
                credit=_parse_amount(_g(row, "Credit")),
                ecriture_let=_g(row, "EcritureLet").strip() or None,
                date_let=_parse_date(_g(row, "DateLet")),
                valid_date=_parse_date(_g(row, "ValidDate")),
                montant_devise=_parse_amount(_g(row, "Montantdevise")) if _g(row, "Montantdevise") else None,
                idevise=_g(row, "Idevise").strip() or None,
                line_number=line_num,
            )

            entries.append(entry)
            report.parsed_entries += 1
            report.journals[entry.journal_code] += 1
            report.comptes[entry.compte_num] += 1
            report.total_debit += entry.debit
            report.total_credit += entry.credit
            if report.period_min is None or ecr_date < report.period_min:
                report.period_min = ecr_date
            if report.period_max is None or ecr_date > report.period_max:
                report.period_max = ecr_date

        except (FECParseError, ValueError) as e:
            report.skipped_lines += 1
            report.errors.append({
                "line": line_num,
                "reason": str(e),
                "raw": delimiter.join(row)[:300],
            })
            if strict:
                raise

    # Vérification équilibre comptable (la loi exige Σdebit == Σcredit)
    diff = abs(report.total_debit - report.total_credit)
    report.is_balanced = diff < Decimal("0.01")

    return entries, report


def parse_fec_bytes(blob: bytes, **kwargs) -> tuple[list[FECEntry], FECParseReport]:
    return parse_fec_stream(io.BytesIO(blob), **kwargs)


# ===========================================================================
# Helpers analytics — exposables côté API
# ===========================================================================

def aggregate_by_journal(entries: Iterable[FECEntry]) -> dict[str, dict]:
    """Σ debit/credit par journal."""
    out: dict[str, dict] = defaultdict(lambda: {"debit": Decimal("0"), "credit": Decimal("0"), "count": 0})
    for e in entries:
        out[e.journal_code]["debit"] += e.debit
        out[e.journal_code]["credit"] += e.credit
        out[e.journal_code]["count"] += 1
    return dict(out)


def aggregate_by_compte_class(entries: Iterable[FECEntry]) -> dict[str, dict]:
    """Σ par classe comptable PCG (1er chiffre du compte : 1=capitaux, 2=immo, 3=stocks, 4=tiers, 5=trésorerie, 6=charges, 7=produits)."""
    out: dict[str, dict] = defaultdict(lambda: {"debit": Decimal("0"), "credit": Decimal("0"), "count": 0})
    for e in entries:
        cls = e.compte_num[:1] if e.compte_num else "?"
        out[cls]["debit"] += e.debit
        out[cls]["credit"] += e.credit
        out[cls]["count"] += 1
    return dict(out)


def detect_anomalies(entries: list[FECEntry], report: FECParseReport) -> list[dict]:
    """Détection heuristique de quelques anomalies typiques."""
    anomalies: list[dict] = []

    # 1. Déséquilibre global
    if not report.is_balanced:
        diff = report.total_debit - report.total_credit
        anomalies.append({
            "type": "global_imbalance",
            "severity": "high",
            "message": f"Déséquilibre global : Σdebit ({report.total_debit}) − Σcredit ({report.total_credit}) = {diff}",
        })

    # 2. Lignes avec debit ET credit non-nuls
    for e in entries:
        if e.debit > 0 and e.credit > 0:
            anomalies.append({
                "type": "debit_and_credit_nonzero",
                "severity": "medium",
                "line": e.line_number,
                "message": f"Ligne {e.line_number} : débit={e.debit} ET crédit={e.credit} (devrait être l'un OU l'autre)",
            })

    # 3. Comptes hors plan comptable (1er chiffre non dans 1-7)
    for e in entries:
        if e.compte_num and e.compte_num[0] not in "1234567":
            anomalies.append({
                "type": "compte_hors_pcg",
                "severity": "low",
                "line": e.line_number,
                "message": f"Ligne {e.line_number} : compte {e.compte_num} hors classes PCG 1-7",
            })

    # 4. Dates futures (impossible pour de la compta)
    today = date.today()
    for e in entries:
        if e.ecriture_date > today:
            anomalies.append({
                "type": "future_date",
                "severity": "high",
                "line": e.line_number,
                "message": f"Ligne {e.line_number} : EcritureDate {e.ecriture_date} dans le futur",
            })

    # 5. Équilibre par EcritureNum (chaque écriture doit être balancée)
    by_num: dict[tuple[str, str], dict] = defaultdict(lambda: {"debit": Decimal("0"), "credit": Decimal("0")})
    for e in entries:
        key = (e.journal_code, e.ecriture_num)
        by_num[key]["debit"] += e.debit
        by_num[key]["credit"] += e.credit
    for (jc, num), totals in by_num.items():
        if abs(totals["debit"] - totals["credit"]) >= Decimal("0.01"):
            anomalies.append({
                "type": "ecriture_imbalance",
                "severity": "high",
                "message": f"Écriture {jc}/{num} déséquilibrée : debit={totals['debit']} credit={totals['credit']}",
            })

    return anomalies[:200]  # cap pour pas exploser
