"""Tests de la machine à états de l'approval-gate (invariant anti param-swap)."""
import os
import tempfile
import time

import approval_store as store


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
