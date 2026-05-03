"""Smoke tests basiques."""
import os

os.environ.setdefault("LINKEDIN_ACCESS_TOKEN", "test-token")
os.environ.setdefault("LINKEDIN_ORGANIZATION_URN", "urn:li:organization:1234")
os.environ.setdefault("LINKEDIN_TOOL_API_KEY", "test-api-key")

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
    assert body["service"] == "aibox-conn-social-linkedin"
    assert body["organization_urn"].startswith("urn:li:organization:")


def test_auth_required():
    r = client.get("/v1/organization")
    assert r.status_code == 401
