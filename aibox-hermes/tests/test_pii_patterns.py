"""Tests du scrub PII FR — notamment l'invariant d'ordre (IBAN avant phone)."""
import pii_patterns as pp


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
