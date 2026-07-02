"""Tests de la machine à états de l'approval-gate (invariant anti param-swap)."""
import importlib
import os
import sys
import tempfile
import time

import approval_store as store

# Le hook (__init__.py) est un package hyphéné (from . import approval_store).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins"))
_appr = importlib.import_module("aibox-approval")


def setup_function(_fn):
    # Isole le répertoire d'approbations par test.
    os.environ["AIBOX_APPROVAL_DIR"] = tempfile.mkdtemp(prefix="aibox-appr-")


def test_created_then_pending_then_approved_allows():
    tool, args = "mcp_pennylane_create_invoice", {"client": "Durand", "amount": 1200}

    v1, rec = store.evaluate(tool, args)
    assert v1 == "created"

    # Ré-appel avant approbation → toujours bloqué (pending), même demande.
    v2, rec2 = store.evaluate(tool, args)
    assert v2 == "pending"
    assert rec2["id"] == rec["id"]

    # L'utilisateur approuve.
    assert store.decide(rec["id"], True)["status"] == "approved"

    # Ré-appel avec les MÊMES args → autorisé, puis consommé.
    v3, _ = store.evaluate(tool, args)
    assert v3 == "allow"

    # Consommé : un nouvel appel recrée une demande.
    v4, _ = store.evaluate(tool, args)
    assert v4 == "created"


def test_param_swap_after_approval_is_blocked():
    tool = "mcp_pennylane_create_invoice"
    _, rec = store.evaluate(tool, {"client": "Durand", "amount": 1200})
    store.decide(rec["id"], True)

    # Un prompt-injection tente de changer le montant après l'approbation.
    v2, rec2 = store.evaluate(tool, {"client": "Durand", "amount": 99999})
    assert v2 == "created"  # hash différent → pas d'approbation valable → re-bloqué
    assert rec2["id"] != rec["id"]


def test_rejected():
    tool = "mcp_x_delete"
    _, rec = store.evaluate(tool, {"id": 1})
    store.decide(rec["id"], False)
    v2, _ = store.evaluate(tool, {"id": 1})
    assert v2 == "rejected"


def test_expiry_recreates():
    tool = "mcp_x_delete"
    _, rec = store.evaluate(tool, {"id": 2}, ttl_s=0)
    time.sleep(0.02)
    v2, rec2 = store.evaluate(tool, {"id": 2})
    assert v2 == "created"
    assert rec2["id"] != rec["id"]


def test_args_hash_order_insensitive():
    a = {"client": "Durand", "amount": 1200}
    b = {"amount": 1200, "client": "Durand"}
    assert store.args_hash(a) == store.args_hash(b)


# --- Fix #1 : tools builtin non préfixés doivent matcher le gate --------------
def test_builtin_verb_first_tools_are_mutating():
    for name in ("send_email", "delete_file", "update_contact", "pay_invoice",
                 "create_event", "refund_order", "cancel_subscription"):
        assert _appr._is_mutating(name), name


def test_case_insensitive_detection():
    assert _appr._is_mutating("SEND_EMAIL")
    assert _appr._is_mutating("Delete_File")


def test_read_only_tools_not_mutating():
    for name in ("get_contacts", "list_invoices", "read_file", "search_emails",
                 "list_accounts", "get_today_agenda"):
        assert not _appr._is_mutating(name), name


def test_prefixed_mutating_still_detected():
    assert _appr._is_mutating("mcp_pennylane_create_invoice")
    assert _appr._is_mutating("mcp_x_delete")


# --- Fix #2 : args en string JSON ou autre type ne sont plus écrasés en {} ----
def test_normalize_args_json_string():
    assert _appr._normalize_args('{"amount": 1200}') == {"amount": 1200}


def test_normalize_args_bad_string_kept_raw():
    # Une string non-JSON est conservée telle quelle (pas écrasée en {}).
    assert _appr._normalize_args("not json") == "not json"


def test_normalize_args_list_kept():
    assert _appr._normalize_args([1, 2, 3]) == [1, 2, 3]


def test_string_args_preserve_param_swap_invariant():
    # Deux args string JSON différents → deux demandes distinctes (pas de collision).
    tool = "send_email"
    a1 = _appr._normalize_args('{"to": "a@b.fr", "body": "coucou"}')
    a2 = _appr._normalize_args('{"to": "a@b.fr", "body": "VIREMENT"}')
    _, rec1 = store.evaluate(tool, a1)
    store.decide(rec1["id"], True)
    # L'approbation de a1 ne doit PAS valider a2 (hash différent).
    v2, _ = store.evaluate(tool, a2)
    assert v2 == "created"


def test_bad_string_args_still_hashable():
    # Avant le fix, une string était écrasée en {} → collision universelle.
    # Maintenant la string brute est hashée : deux strings ≠ ne collisionnent pas.
    tool = "send_email"
    _, rec1 = store.evaluate(tool, _appr._normalize_args("raw-args-A"))
    store.decide(rec1["id"], True)
    v2, _ = store.evaluate(tool, _appr._normalize_args("raw-args-B"))
    assert v2 == "created"


# --- Fix #4 : l'approbation est liée à la session ----------------------------
def test_approval_bound_to_session():
    tool, args = "send_email", {"to": "a@b.fr"}
    _, rec = store.evaluate(tool, args, session_id="sessA")
    store.decide(rec["id"], True)
    # Une autre session ne peut pas consommer l'approbation de sessA.
    vB, _ = store.evaluate(tool, args, session_id="sessB")
    assert vB == "created"
    # La session d'origine, elle, est bien autorisée.
    vA, _ = store.evaluate(tool, args, session_id="sessA")
    assert vA == "allow"


def test_approval_consumed_atomically_single_allow():
    tool, args = "send_email", {"to": "a@b.fr"}
    _, rec = store.evaluate(tool, args, session_id="sessA")
    store.decide(rec["id"], True)
    v1, _ = store.evaluate(tool, args, session_id="sessA")
    assert v1 == "allow"
    # Deuxième appel : l'approbation a été consommée (fichier unlink) → recréée.
    v2, _ = store.evaluate(tool, args, session_id="sessA")
    assert v2 == "created"
