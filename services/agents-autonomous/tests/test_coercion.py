"""Tests unitaires des helpers de coercion défensive.

Run : `pytest tests/test_coercion.py -v`

Pas de réseau, pas de LLM — juste valider le comportement des helpers.
"""
from __future__ import annotations

import pytest

from app.utils.coercion import (
    DEFAULT_KEY_MAP,
    autodetect_list_field,
    coerce_str_list,
    normalize_keys,
)


# ===== normalize_keys =====================================================

def test_normalize_keys_simple_fr_to_en():
    assert normalize_keys({"résumé": "test"}) == {"summary": "test"}
    assert normalize_keys({"livrables": [1, 2]}) == {"deliverables": [1, 2]}


def test_normalize_keys_nested():
    assert normalize_keys({"livrables": [{"description": "X"}]}) == {
        "deliverables": [{"description": "X"}]
    }


def test_normalize_keys_unwraps_top_level():
    assert normalize_keys({"output": {"summary": "x"}}) == {"summary": "x"}
    assert normalize_keys({"result": {"a": 1}}) == {"a": 1}


def test_normalize_keys_unwraps_nested_wrappers():
    # Le LLM peut wrapper plusieurs fois ; on déballe successivement tant que
    # le top-level a une seule clé qui est un wrapper connu.
    assert normalize_keys({"data": {"output": {"x": 1}}}) == {"x": 1}


def test_normalize_keys_stops_unwrap_when_real_content():
    # Si après un unwrap le contenu n'est plus un wrapper, on s'arrête.
    assert normalize_keys({"output": {"summary": "x", "intent": "y"}}) == {
        "summary": "x", "intent": "y"
    }


def test_normalize_keys_passthrough_unknown():
    assert normalize_keys({"unknown_key": "v"}) == {"unknown_key": "v"}


def test_normalize_keys_action_to_suggested_action():
    assert normalize_keys({"action": "X"}) == {"suggested_action": "X"}


def test_normalize_keys_handles_lists():
    assert normalize_keys([{"livrables": [1]}, {"prix": 100}]) == [
        {"deliverables": [1]},
        {"unit_price_eur": 100},
    ]


def test_normalize_keys_handles_scalars():
    assert normalize_keys("hello") == "hello"
    assert normalize_keys(42) == 42
    assert normalize_keys(None) is None


# ===== coerce_str_list ====================================================

def test_coerce_str_list_already_strings():
    assert coerce_str_list(["a", "b"]) == ["a", "b"]


def test_coerce_str_list_dicts_in_list():
    assert coerce_str_list([{"k": "v"}]) == ["k: v"]


def test_coerce_str_list_dict_with_categories():
    out = coerce_str_list({"delays": ["8 sem"], "tech": ["Stripe"]})
    assert "delays: 8 sem" in out
    assert "tech: Stripe" in out
    assert len(out) == 2


def test_coerce_str_list_dict_simple_kv():
    out = coerce_str_list({"key": "val"})
    assert out == ["key: val"]


def test_coerce_str_list_string_to_list():
    assert coerce_str_list("single") == ["single"]


def test_coerce_str_list_none():
    assert coerce_str_list(None) == []


def test_coerce_str_list_scalar():
    assert coerce_str_list(42) == ["42"]


# ===== autodetect_list_field ==============================================

def test_autodetect_finds_items_list():
    d = {"lignes_de_devis": [{"description": "X"}]}
    out = autodetect_list_field(d, "items", ("description",))
    assert "items" in out
    assert out["items"][0]["description"] == "X"


def test_autodetect_no_op_if_already_present():
    d = {"items": [{"x": 1}], "other": "val"}
    out = autodetect_list_field(d, "items", ("description",))
    # Ne touche pas si déjà présent
    assert out["items"] == [{"x": 1}]


def test_autodetect_no_match():
    d = {"foo": [{"unknown": 1}]}
    out = autodetect_list_field(d, "items", ("description", "name"))
    assert "items" not in out


def test_autodetect_handles_non_dict():
    assert autodetect_list_field("not a dict", "items", ("x",)) == "not a dict"
    assert autodetect_list_field([1, 2, 3], "items", ("x",)) == [1, 2, 3]


# ===== Combinaisons réalistes (cas observés en prod) =====================

def test_real_quote_brief_dict_output():
    # Cas observé : LLM retourne {"resume": "...", "livrables": [...], "ambiguites": []}
    raw = {
        "resume": "Création site",
        "livrables": ["Site", "Catalogue"],
        "contraintes": [{"délai": "8 sem"}, {"budget": "15k€"}],
        "ambiguites": [],
    }
    normalized = normalize_keys(raw)
    assert normalized["summary"] == "Création site"
    assert normalized["deliverables"] == ["Site", "Catalogue"]
    # Le coerce_str_list sera appelé par le field_validator
    assert coerce_str_list(normalized["constraints"]) == [
        "délai: 8 sem", "budget: 15k€"
    ]


def test_real_dict_with_categories_constraints():
    # Cas observé : {"constraints": {"delays": [...], "tech": [...]}}
    raw = {"constraints": {"delays": ["8 sem"], "tech": ["Stripe", "PayPal"]}}
    normalized = normalize_keys(raw)
    coerced = coerce_str_list(normalized["constraints"])
    assert "delays: 8 sem" in coerced
    assert any("Stripe" in s for s in coerced)


def test_real_qwen_output_with_action_key():
    # Cas observé email_triage : {"intent": "...", "action": "devis_a_generer"}
    raw = {"intent": "Demande devis", "action": "devis_a_generer"}
    normalized = normalize_keys(raw)
    assert normalized == {"intent": "Demande devis", "suggested_action": "devis_a_generer"}
