"""Tests du backend RBAC AI Box (plugins/aibox-rights/dashboard/plugin_api.py).

Couvre les fixes sécurité :
  - écriture atomique de roles.json (reste valide après écritures multiples) ;
  - _aibox_root() robuste quand une entreprise/user s'appelle « aibox » ;
  - /set rejette rôle invalide ET user inexistant (400) ;
  - _load_roles() ne rétrograde PAS tout le monde sur JSON corrompu (fail-closed) ;
  - /users et /set exigent admin (403 sinon), et fail-closed sur rôles corrompus.

Les helpers de plugin_api lisent HERMES_HOME depuis l'environnement à chaque
appel → on pointe HERMES_HOME vers un arbre factice construit dans tmp_path :
    <root>/companies/<co>/users/<user>/hermes
"""
import asyncio
import json
import os

import pytest
from fastapi import HTTPException

import plugin_api as pa


def _make_tree(root, company="acme", user="alice", role_root_name="aibox"):
    """Construit <root>/<role_root_name>/companies/<co>/users/<user>/hermes.

    Retourne (aibox_root, hermes_home) et positionne HERMES_HOME sur hermes_home.
    """
    aibox_root = root / role_root_name
    hermes_home = aibox_root / "companies" / company / "users" / user / "hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(hermes_home)
    return aibox_root, hermes_home


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _clean_env():
    old = os.environ.get("HERMES_HOME")
    yield
    if old is None:
        os.environ.pop("HERMES_HOME", None)
    else:
        os.environ["HERMES_HOME"] = old


# ── _aibox_root : structure, pas le nom « aibox » ───────────────────────────
def test_aibox_root_anchors_on_companies_structure(tmp_path):
    aibox_root, _ = _make_tree(tmp_path, company="acme", user="alice")
    assert pa._aibox_root() == aibox_root
    assert pa._roles_path() == aibox_root / "roles.json"


def test_aibox_root_company_named_aibox(tmp_path):
    # Une ENTREPRISE nommée « aibox » ne doit pas faire s'arrêter la remontée
    # au mauvais niveau : la racine reste l'ancêtre qui contient « companies ».
    aibox_root, _ = _make_tree(tmp_path, company="aibox", user="bob", role_root_name="aibox")
    assert pa._aibox_root() == aibox_root
    # sanity : le user est bien listable et rattaché à l'entreprise « aibox »
    assert pa._list_users() == ["bob"]


def test_aibox_root_user_named_aibox(tmp_path):
    # Un USER nommé « aibox » ne doit pas non plus casser l'ancrage.
    aibox_root, _ = _make_tree(tmp_path, company="acme", user="aibox", role_root_name="aibox")
    assert pa._aibox_root() == aibox_root
    assert pa._list_users() == ["aibox"]


def test_current_user_derived_from_home(tmp_path):
    _make_tree(tmp_path, company="acme", user="carol")
    assert pa._current_user() == "carol"


# ── Écriture atomique : roles.json reste valide après plusieurs écritures ────
def test_save_roles_atomic_stays_valid(tmp_path):
    aibox_root, _ = _make_tree(tmp_path, user="alice")
    for i in range(20):
        pa._save_roles({"alice": "admin", "bob": "client", "n": i})
    p = pa._roles_path()
    data = json.loads(p.read_text(encoding="utf-8"))   # ne doit pas lever
    assert data["alice"] == "admin"
    assert data["n"] == 19
    # Aucun fichier temporaire laissé traîner.
    leftovers = list(aibox_root.glob("roles.json.tmp.*"))
    assert leftovers == []


def test_save_then_load_roundtrip(tmp_path):
    _make_tree(tmp_path, user="alice")
    pa._save_roles({"alice": "admin"})
    assert pa._load_roles() == {"alice": "admin"}
    assert pa._role_of("alice") == "admin"
    assert pa._role_of("inconnu") == "client"   # défaut fail-safe


# ── Corruption : NE rétrograde PAS tout le monde en « client » ──────────────
def test_load_roles_corrupt_raises_not_empty(tmp_path):
    _make_tree(tmp_path, user="alice")
    pa._roles_path().write_text("{ ceci n'est pas du JSON", encoding="utf-8")
    with pytest.raises(pa.RolesCorrupt):
        pa._load_roles()


def test_load_roles_non_dict_raises(tmp_path):
    _make_tree(tmp_path, user="alice")
    pa._roles_path().write_text('["liste", "au lieu", "objet"]', encoding="utf-8")
    with pytest.raises(pa.RolesCorrupt):
        pa._load_roles()


def test_require_admin_fail_closed_on_corruption(tmp_path):
    # roles.json corrompu → l'admin courant ne doit PAS être « promu » ni
    # « rétrogradé silencieusement » : _require_admin refuse (503), fail-closed.
    _make_tree(tmp_path, user="alice")
    pa._roles_path().write_text("garbage{", encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        pa._require_admin()
    assert ei.value.status_code == 503


def test_me_fail_closed_on_corruption_returns_client(tmp_path):
    _make_tree(tmp_path, user="alice")
    pa._roles_path().write_text("nope", encoding="utf-8")
    out = _run(pa.me())
    assert out == {"user": "alice", "role": "client"}   # jamais admin par défaut


# ── /users et /set : admin-only, fail-closed ────────────────────────────────
def test_users_requires_admin(tmp_path):
    _make_tree(tmp_path, user="alice")
    pa._save_roles({"alice": "client"})   # appelant = client
    with pytest.raises(HTTPException) as ei:
        _run(pa.users())
    assert ei.value.status_code == 403


def test_set_requires_admin(tmp_path):
    _make_tree(tmp_path, company="acme", user="alice")
    # bob existe aussi dans l'entreprise
    (tmp_path / "aibox" / "companies" / "acme" / "users" / "bob" / "hermes").mkdir(parents=True)
    pa._save_roles({"alice": "client"})   # appelant alice = client → interdit
    with pytest.raises(HTTPException) as ei:
        _run(pa.set_role({"user": "bob", "role": "admin"}))
    assert ei.value.status_code == 403


# ── /set : validation du user cible et du rôle ──────────────────────────────
def _admin_tree_with(tmp_path, extra_users=()):
    """alice = admin ; crée aussi des users additionnels dans la même entreprise."""
    _make_tree(tmp_path, company="acme", user="alice")
    base = tmp_path / "aibox" / "companies" / "acme" / "users"
    for u in extra_users:
        (base / u / "hermes").mkdir(parents=True, exist_ok=True)
    pa._save_roles({"alice": "admin"})


def test_set_rejects_invalid_role(tmp_path):
    _admin_tree_with(tmp_path, extra_users=["bob"])
    with pytest.raises(HTTPException) as ei:
        _run(pa.set_role({"user": "bob", "role": "superadmin"}))
    assert ei.value.status_code == 400


def test_set_rejects_unknown_user(tmp_path):
    _admin_tree_with(tmp_path, extra_users=["bob"])
    with pytest.raises(HTTPException) as ei:
        _run(pa.set_role({"user": "charlie", "role": "client"}))
    assert ei.value.status_code == 400
    # rien n'a été écrit pour l'utilisateur fantôme
    assert "charlie" not in pa._load_roles()


def test_set_rejects_path_traversal_user(tmp_path):
    _admin_tree_with(tmp_path, extra_users=["bob"])
    with pytest.raises(HTTPException) as ei:
        _run(pa.set_role({"user": "../evil", "role": "admin"}))
    assert ei.value.status_code == 400
    assert "../evil" not in pa._load_roles()


def test_set_rejects_empty_user(tmp_path):
    _admin_tree_with(tmp_path, extra_users=["bob"])
    with pytest.raises(HTTPException) as ei:
        _run(pa.set_role({"user": "", "role": "admin"}))
    assert ei.value.status_code == 400


def test_set_accepts_valid_user_and_role(tmp_path):
    _admin_tree_with(tmp_path, extra_users=["bob"])
    out = _run(pa.set_role({"user": "bob", "role": "admin"}))
    assert out == {"ok": True, "user": "bob", "role": "admin"}
    assert pa._load_roles()["bob"] == "admin"
    # relecture : toujours valide, alice conserve son rôle
    assert pa._load_roles()["alice"] == "admin"
