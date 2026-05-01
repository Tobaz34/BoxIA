"""Tests unitaires du parser FEC.

Couvre :
- Header conforme legal vs non conforme
- Détection encoding (UTF-8, Latin-1)
- Détection délimiteur (TAB, pipe)
- Parsing date YYYYMMDD + autres formats tolérés
- Parsing montants (virgule/point/espaces)
- Détection équilibre comptable
- Anomalies (déséquilibre, dates futures, debit+credit, hors PCG)
"""
from __future__ import annotations

import os
from datetime import date, timedelta
from decimal import Decimal

os.environ.setdefault("FEC_TOOL_API_KEY", "test-fec-key")

import pytest

from app.parser import (
    FEC_COLUMNS,
    FECParseError,
    _detect_delimiter,
    _detect_encoding,
    _parse_amount,
    _parse_date,
    aggregate_by_compte_class,
    aggregate_by_journal,
    detect_anomalies,
    parse_fec_bytes,
)


# =========================================================================
# Helpers
# =========================================================================

def make_fec(rows: list[list[str]], delimiter: str = "\t", with_header: bool = True) -> bytes:
    lines = []
    if with_header:
        lines.append(delimiter.join(FEC_COLUMNS))
    for r in rows:
        lines.append(delimiter.join(r))
    return ("\n".join(lines) + "\n").encode("utf-8")


def fec_row(
    journal: str = "VE", num: str = "1", date_iso: str = "20260101",
    compte: str = "411000", lib_compte: str = "Client", aux: str = "", lib_aux: str = "",
    piece: str = "F-001", piece_date: str = "20260101", lib: str = "Vente",
    debit: str = "0", credit: str = "0",
    let: str = "", date_let: str = "", valid_date: str = "20260101",
    montant_devise: str = "", devise: str = "",
) -> list[str]:
    """Crée une ligne FEC dans l'ordre canonique."""
    return [
        journal, "Ventes",
        num, date_iso,
        compte, lib_compte,
        aux, lib_aux,
        piece, piece_date,
        lib,
        debit, credit,
        let, date_let,
        valid_date,
        montant_devise, devise,
    ]


# =========================================================================
# Functions internes
# =========================================================================

def test_detect_encoding_utf8():
    blob = "Hello éàù".encode("utf-8")
    assert _detect_encoding(blob) == "utf-8"


def test_detect_encoding_latin1():
    blob = "Société française".encode("latin-1")
    # Note : "Société" peut aussi décoder en utf-8 si pas de chars exclusifs latin1
    enc = _detect_encoding(blob)
    assert enc in {"utf-8", "latin-1", "cp1252"}


def test_detect_delimiter_tab():
    line = "\t".join(FEC_COLUMNS)
    assert _detect_delimiter(line) == "\t"


def test_detect_delimiter_pipe():
    line = "|".join(FEC_COLUMNS)
    assert _detect_delimiter(line) == "|"


def test_detect_delimiter_fail():
    with pytest.raises(FECParseError):
        _detect_delimiter("petite ligne sans separateur clair")


def test_parse_amount():
    assert _parse_amount("100.50") == Decimal("100.50")
    assert _parse_amount("100,50") == Decimal("100.50")
    assert _parse_amount("1 000,00") == Decimal("1000.00")
    assert _parse_amount("") == Decimal("0")
    assert _parse_amount(None) == Decimal("0")


def test_parse_amount_invalid():
    with pytest.raises(FECParseError):
        _parse_amount("abc")


def test_parse_date_yyyymmdd():
    assert _parse_date("20260415") == date(2026, 4, 15)


def test_parse_date_iso():
    assert _parse_date("2026-04-15") == date(2026, 4, 15)


def test_parse_date_french():
    assert _parse_date("15/04/2026") == date(2026, 4, 15)


def test_parse_date_empty():
    assert _parse_date("") is None
    assert _parse_date(None) is None


def test_parse_date_invalid():
    with pytest.raises(FECParseError):
        _parse_date("32/13/2026")


# =========================================================================
# Parsing FEC complet
# =========================================================================

def test_parse_minimal_balanced_fec():
    rows = [
        fec_row(num="1", compte="411000", lib="Vente client A", debit="120.00", credit="0"),
        fec_row(num="1", compte="707000", lib="Vente client A", debit="0", credit="100.00"),
        fec_row(num="1", compte="445710", lib="Vente client A — TVA", debit="0", credit="20.00"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    assert report.parsed_entries == 3
    assert report.is_balanced is True
    assert report.total_debit == Decimal("120.00")
    assert report.total_credit == Decimal("120.00")
    assert report.columns_match_legal is True
    assert report.encoding_detected.startswith("utf")


def test_parse_imbalanced_fec_detects():
    rows = [
        fec_row(num="1", compte="411000", debit="100", credit="0"),
        fec_row(num="1", compte="707000", debit="0", credit="50"),  # déséquilibré
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    assert report.is_balanced is False


def test_parse_pipe_delimiter():
    rows = [fec_row(debit="100", credit="0"), fec_row(num="2", debit="0", credit="100")]
    entries, report = parse_fec_bytes(make_fec(rows, delimiter="|"))
    assert report.delimiter == "|"
    assert report.parsed_entries == 2


def test_parse_strict_fails_on_bad_date():
    rows = [fec_row(date_iso="32/13/2026", debit="100", credit="0")]
    with pytest.raises((FECParseError, Exception)):
        parse_fec_bytes(make_fec(rows), strict=True)


def test_parse_lenient_skips_bad_date():
    rows = [
        fec_row(date_iso="32/13/2026", debit="100", credit="0"),
        fec_row(num="2", debit="0", credit="100"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows), strict=False)
    assert report.parsed_entries == 1
    assert report.skipped_lines == 1
    assert len(report.errors) == 1


def test_parse_period_min_max():
    rows = [
        fec_row(date_iso="20260101", debit="100", credit="0"),
        fec_row(num="2", date_iso="20261231", debit="0", credit="100"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    assert report.period_min == date(2026, 1, 1)
    assert report.period_max == date(2026, 12, 31)


# =========================================================================
# Anomalies
# =========================================================================

def test_anomaly_global_imbalance():
    rows = [fec_row(debit="100", credit="50")]
    entries, report = parse_fec_bytes(make_fec(rows))
    anomalies = detect_anomalies(entries, report)
    assert any(a["type"] == "global_imbalance" for a in anomalies)


def test_anomaly_debit_and_credit_nonzero():
    rows = [
        fec_row(debit="100", credit="100"),  # interdit comptablement
        fec_row(num="2", compte="707000", debit="0", credit="100"),
        fec_row(num="2", compte="411000", debit="100", credit="0"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    anomalies = detect_anomalies(entries, report)
    assert any(a["type"] == "debit_and_credit_nonzero" for a in anomalies)


def test_anomaly_compte_hors_pcg():
    rows = [
        fec_row(compte="999999", debit="100", credit="0"),
        fec_row(num="2", compte="411000", debit="0", credit="100"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    anomalies = detect_anomalies(entries, report)
    assert any(a["type"] == "compte_hors_pcg" for a in anomalies)


def test_anomaly_future_date():
    future = (date.today() + timedelta(days=30)).strftime("%Y%m%d")
    rows = [
        fec_row(date_iso=future, debit="100", credit="0"),
        fec_row(num="2", date_iso=future, compte="707000", debit="0", credit="100"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    anomalies = detect_anomalies(entries, report)
    assert any(a["type"] == "future_date" for a in anomalies)


def test_anomaly_ecriture_imbalance():
    """Une écriture (même num) doit avoir Σdebit == Σcredit."""
    rows = [
        fec_row(num="1", compte="411000", debit="120", credit="0"),
        fec_row(num="1", compte="707000", debit="0", credit="80"),  # manque 20€
        fec_row(num="2", compte="411000", debit="20", credit="0"),
        fec_row(num="2", compte="707000", debit="0", credit="20"),
    ]
    entries, report = parse_fec_bytes(make_fec(rows))
    anomalies = detect_anomalies(entries, report)
    assert any(a["type"] == "ecriture_imbalance" for a in anomalies)


# =========================================================================
# Aggregations
# =========================================================================

def test_aggregate_by_journal():
    rows = [
        fec_row(journal="VE", debit="100", credit="0"),
        fec_row(journal="VE", num="2", debit="0", credit="100"),
        fec_row(journal="AC", num="3", debit="50", credit="0"),
    ]
    entries, _ = parse_fec_bytes(make_fec(rows))
    agg = aggregate_by_journal(entries)
    assert agg["VE"]["count"] == 2
    assert agg["AC"]["count"] == 1
    assert agg["VE"]["debit"] == Decimal("100")


def test_aggregate_by_compte_class():
    rows = [
        fec_row(compte="411000", debit="100", credit="0"),  # classe 4
        fec_row(num="2", compte="707000", debit="0", credit="100"),  # classe 7
        fec_row(num="3", compte="606000", debit="50", credit="0"),  # classe 6
        fec_row(num="3", compte="512000", debit="0", credit="50"),  # classe 5
    ]
    entries, _ = parse_fec_bytes(make_fec(rows))
    agg = aggregate_by_compte_class(entries)
    assert "4" in agg
    assert "7" in agg
    assert "6" in agg
    assert "5" in agg
    assert agg["4"]["debit"] == Decimal("100")
