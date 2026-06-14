"""Tests du rendu de config + RBAC par connecteur."""
import render_config as rc


def test_model_and_base_url_present():
    out = rc.render("qwen3:14b", "http://ollama/v1", ["pennylane"], "/repo")
    assert 'default: "qwen3:14b"' in out
    assert 'base_url: "http://ollama/v1"' in out


def test_allowed_connector_present():
    out = rc.render("m", "u", ["pennylane"], "/repo")
    assert "pennylane:" in out
    assert "/repo/mcp-connectors/pennylane/server.py" in out


def test_rbac_user_without_connector_gets_none():
    out = rc.render("m", "u", [], "/repo")
    assert "pennylane:" not in out
    assert "mcp_servers:" in out          # section présente mais vide
    assert "{}" in out


def test_unknown_connector_ignored():
    out = rc.render("m", "u", ["pennylane", "inexistant"], "/repo")
    assert "pennylane:" in out
    assert "inexistant" not in out


def test_skills_dir_always_present():
    out = rc.render("m", "u", [], "/repo")
    assert '/repo/skills' in out


def test_context_length_override_present():
    # Hermes refuse un modèle < 64K → la config DOIT forcer context_length.
    out = rc.render("qwen3:14b", "u", [], "/repo")
    assert "context_length: 65536" in out
