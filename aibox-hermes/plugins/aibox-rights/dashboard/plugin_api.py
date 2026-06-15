# Backend du plugin « Utilisateurs » (gestion des droits AI Box).
# Routes montées sous /api/plugins/aibox-rights/. Tourne dans le process du
# dashboard de l'utilisateur courant (un par user) → l'identité = HERMES_HOME.
# Source de vérité des rôles : <AIBOX_ROOT>/roles.json (écrit par le dashboard,
# clikinfo). Les routes d'écriture exigent que l'utilisateur courant soit admin.
import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()


def _hermes_home() -> Path:
    hh = os.environ.get("HERMES_HOME", "")
    if not hh:
        try:
            from hermes_cli.web_server import get_hermes_home
            hh = str(get_hermes_home())
        except Exception:
            hh = str(Path.home() / ".hermes")
    return Path(hh)


def _aibox_root() -> Path:
    # HERMES_HOME = <root>/companies/<co>/users/<user>/hermes → <root> = ancêtre "aibox"
    hh = _hermes_home()
    for anc in [hh, *hh.parents]:
        if anc.name == "aibox":
            return anc
    # repli : 5 niveaux au-dessus (…/users/<user>/hermes)
    return hh.parents[4] if len(hh.parents) >= 5 else hh.parent


def _current_user() -> str:
    # HERMES_HOME = …/users/<user>/hermes → user = parent.name
    return _hermes_home().parent.name


def _roles_path() -> Path:
    return _aibox_root() / "roles.json"


def _load_roles() -> dict:
    p = _roles_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_roles(d: dict) -> None:
    p = _roles_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _role_of(user: str, roles: dict | None = None) -> str:
    roles = _load_roles() if roles is None else roles
    return roles.get(user, "client")   # défaut : client (chat seul)


def _list_users() -> list[str]:
    root = _aibox_root()
    users: set[str] = set()
    companies = root / "companies"
    if companies.is_dir():
        for comp in companies.iterdir():
            ud = comp / "users"
            if ud.is_dir():
                for u in ud.iterdir():
                    if u.is_dir():
                        users.add(u.name)
    return sorted(users)


def _require_admin() -> str:
    u = _current_user()
    if _role_of(u) != "admin":
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs.")
    return u


@router.get("/me")
async def me():
    u = _current_user()
    return {"user": u, "role": _role_of(u)}


@router.get("/users")
async def users():
    _require_admin()
    roles = _load_roles()
    return {"users": [{"user": u, "role": _role_of(u, roles)} for u in _list_users()]}


@router.post("/set")
async def set_role(body: dict):
    _require_admin()
    user = str(body.get("user", "")).strip()
    role = str(body.get("role", "")).strip()
    if not user or role not in ("client", "admin"):
        raise HTTPException(status_code=400, detail="Paramètres invalides (role = client|admin).")
    roles = _load_roles()
    roles[user] = role
    _save_roles(roles)
    return {"ok": True, "user": user, "role": role}
