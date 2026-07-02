"""Tests du scrub PII FR — notamment l'invariant d'ordre (IBAN avant phone)."""
import importlib
import os
import sys

import pii_patterns as pp

# Le hook RGPD (__init__.py du plugin) fait `from . import pii_patterns`, donc il
# faut l'importer comme package : on ajoute plugins/ au sys.path et on charge le
# package hyphéné via importlib.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins"))
_rgpd = importlib.import_module("aibox-rgpd")


def test_iban_not_eaten_by_phone():
    txt = "Virement vers IBAN FR76 3000 6000 0112 3456 7890 189 du client"
    out, n, by = pp.scrub_pii(txt)
    assert "[IBAN_REDACTED]" in out
    assert "[PHONE_REDACTED]" not in out  # phone ne doit PAS grignoter l'IBAN
    assert by.get("iban") == 1


def test_email():
    out, n, by = pp.scrub_pii("Contact : jean.dupont@example.fr svp")
    assert "[EMAIL_REDACTED]" in out
    assert by["email"] == 1


def test_phone_fr_variants():
    for ph in ["06 12 34 56 78", "06.12.34.56.78", "+33 6 12 34 56 78", "0612345678"]:
        out, n, by = pp.scrub_pii(f"Appelle-moi au {ph} demain")
        assert "[PHONE_REDACTED]" in out, ph


def test_siret_and_siren():
    out, n, by = pp.scrub_pii("Notre SIRET 732 829 320 00074 figure ici")
    assert "[SIRET_REDACTED]" in out
    out2, n2, by2 = pp.scrub_pii("SIREN 732 829 320 enregistré")
    assert "[SIREN_REDACTED]" in out2


def test_nir():
    out, n, by = pp.scrub_pii("NIR 1 84 04 75 116 003 42 du salarié")
    assert "[NIR_REDACTED]" in out


def test_credit_card():
    out, n, by = pp.scrub_pii("Carte 4970 1234 5678 9012 expirée")
    assert "[CARD_REDACTED]" in out


def test_no_pii_unchanged():
    txt = "Bonjour, peux-tu me résumer la réunion d'hier ?"
    out, n, by = pp.scrub_pii(txt)
    assert n == 0
    assert out == txt
    assert by == {}


def test_empty():
    assert pp.scrub_pii("") == ("", 0, {})


def test_multiple_types_counted():
    txt = "Mail a@b.fr, tel 06 12 34 56 78, IBAN FR76 3000 6000 0112 3456 7890 189"
    out, n, by = pp.scrub_pii(txt)
    assert n >= 3
    assert by.get("email") == 1
    assert by.get("iban") == 1
    assert by.get("phone_fr") == 1


# --- Fix #6 : IBAN en minuscules doit être caviardé (IGNORECASE) --------------
def test_iban_lowercase_redacted():
    txt = "Virement vers iban fr76 3000 6000 0112 3456 7890 189 du client"
    out, n, by = pp.scrub_pii(txt)
    assert "[IBAN_REDACTED]" in out
    assert by.get("iban") == 1
    # Le pattern téléphone ne doit pas grignoter l'IBAN minuscule.
    assert "[PHONE_REDACTED]" not in out


# --- Fix #7 : SIREN/SIRET avec points ou tirets ------------------------------
def test_siren_with_dots():
    out, n, by = pp.scrub_pii("SIREN 732.829.320 enregistré")
    assert "[SIREN_REDACTED]" in out


def test_siren_with_dashes():
    out, n, by = pp.scrub_pii("SIREN 732-829-320 enregistré")
    assert "[SIREN_REDACTED]" in out


def test_siret_with_dots():
    out, n, by = pp.scrub_pii("SIRET 732.829.320.00074 figure ici")
    assert "[SIRET_REDACTED]" in out


def test_phone_still_not_matched_as_siren():
    # Régression : un téléphone à points reste un téléphone, pas un SIREN.
    out, n, by = pp.scrub_pii("Appelle-moi au 06.12.34.56.78 demain")
    assert "[PHONE_REDACTED]" in out
    assert "[SIREN_REDACTED]" not in out


# --- Fix #5 : résultat structuré (dict/list) scrubé récursivement ------------
def _scrub_enabled():
    os.environ["AIBOX_RGPD_SCRUB"] = "1"


def test_dict_result_scrubbed_recursively():
    _scrub_enabled()
    result = {
        "client": "Durand",
        "email": "jean.dupont@example.fr",
        "coords": {"iban": "FR76 3000 6000 0112 3456 7890 189"},
        "notes": ["appeler 06 12 34 56 78", "rien"],
    }
    out = _rgpd._on_transform_tool_result(tool_name="mcp_pennylane_get", result=result)
    assert out is not None and isinstance(out, dict)
    assert out["email"] == "[EMAIL_REDACTED]"
    assert out["coords"]["iban"] == "[IBAN_REDACTED]"
    assert "[PHONE_REDACTED]" in out["notes"][0]
    assert out["client"] == "Durand"  # non-PII préservé


def test_list_result_scrubbed():
    _scrub_enabled()
    result = ["contact a@b.fr", "SIREN 732.829.320", "neutre"]
    out = _rgpd._on_transform_tool_result(tool_name="x", result=result)
    assert out is not None and isinstance(out, list)
    assert "[EMAIL_REDACTED]" in out[0]
    assert "[SIREN_REDACTED]" in out[1]


def test_dict_result_no_pii_returns_none():
    _scrub_enabled()
    out = _rgpd._on_transform_tool_result(tool_name="x", result={"a": "bonjour", "b": 42})
    assert out is None  # rien à caviarder → laisse inchangé
