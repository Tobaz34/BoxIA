"""Smoke tests basiques.

Ne couvre pas les appels Graph API réels (mockés via respx en V2).
"""
import os

os.environ.setdefault("META_PAGE_ACCESS_TOKEN", "test-token")
os.environ.setdefault("META_TOOL_API_KEY", "test-api-key")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.text == "OK"


def test_info():
    r = client.get("/v1/info")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "aibox-conn-social-meta"
    assert body["graph_version"].startswith("v")


def test_auth_required():
    r = client.get("/v1/fb/pages")
    assert r.status_code == 401


def test_auth_wrong_key():
    r = client.get(
        "/v1/fb/pages",
        headers={"Authorization": "Bearer wrong-key"},
    )
    assert r.status_code == 401
