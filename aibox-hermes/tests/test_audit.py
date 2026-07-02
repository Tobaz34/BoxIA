"""Tests du plugin audit (construction de record + append + rotation)."""
import os
import tempfile

import audit_log as al


def setup_function(_fn):
    d = tempfile.mkdtemp(prefix="aibox-audit-")
    os.environ["AIBOX_AUDIT_FILE"] = os.path.join(d, "audit.jsonl")


def test_build_record_basic():
    r = al.build_record(
        "mcp_pennylane_create_invoice", {"amount": 1200}, '{"ok": true}',
        duration_ms=12, session_id="sess1", ts=1000.0, mutating=True,
    )
    assert r["tool"] == "mcp_pennylane_create_invoice"
    assert r["mutating"] is True
    assert r["error"] is False
    assert r["ts"] == 1000.0
    assert "1200" in r["args"]


def test_error_detected():
    r = al.build_record("x", {}, '{"error": "boom"}', 0)
    assert r["error"] is True


def test_args_truncated_to_200():
    r = al.build_record("x", {"blob": "x" * 1000}, None, 0)
    assert len(r["args"]) <= 200


def test_append_and_read_order():
    al.append(al.build_record("a", {}, None, 0, ts=1.0))
    al.append(al.build_record("b", {}, None, 0, ts=2.0))
    rows = al.read_all()
    assert [x["tool"] for x in rows] == ["a", "b"]


def test_rotation_keeps_most_recent():
    for i in range(10):
        al.append(al.build_record(f"t{i}", {}, None, 0, ts=float(i)), max_entries=5)
    rows = al.read_all()
    assert len(rows) == 5
    assert rows[0]["tool"] == "t5"   # plus anciennes droppées
    assert rows[-1]["tool"] == "t9"


# --- Fix #8 : une ligne JSON corrompue ne fait plus crasher read_all ----------
def test_read_all_skips_corrupt_line():
    al.append(al.build_record("a", {}, None, 0, ts=1.0))
    # Ligne corrompue injectée manuellement (écriture interrompue, edit manuel).
    with open(al.audit_path(), "a", encoding="utf-8") as f:
        f.write("{ceci n'est pas du JSON valide\n")
    al.append(al.build_record("b", {}, None, 0, ts=2.0))
    rows = al.read_all()  # ne doit PAS lever JSONDecodeError
    assert [x["tool"] for x in rows] == ["a", "b"]  # la ligne corrompue est sautée
