"""Tests du scoring d'urgence email (déterministe)."""
import urgency as u


def test_high_mise_en_demeure():
    assert u.score_urgency("URGENT : mise en demeure", "")["level"] == "haute"


def test_med_relance():
    assert u.score_urgency("Relance facture", "")["level"] == "moyenne"


def test_high_relance_impaye():
    r = u.score_urgency("Relance — facture impayé", "")
    assert r["score"] >= 4 and r["level"] == "haute"


def test_low_newsletter():
    assert u.score_urgency("Newsletter hebdo", "Nos actus du mois")["level"] == "basse"


def test_vip_sender_bumps():
    r = u.score_urgency("petit point", "", sender="patron@client.fr", vips=["patron@client.fr"])
    assert r["level"] == "moyenne"
    assert any("VIP" in x for x in r["reasons"])


def test_reasons_listed():
    r = u.score_urgency("huissier", "")
    assert r["level"] == "haute"
    assert r["reasons"]
