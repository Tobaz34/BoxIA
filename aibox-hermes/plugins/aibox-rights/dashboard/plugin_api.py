# Backend du plugin « Utilisateurs » (gestion des droits AI Box).
# Routes montées sous /api/plugins/aibox-rights/. Tourne dans le process du
# dashboard de l'utilisateur courant (un par user) → l'identité = HERMES_HOME.
# Source de vérité des rôles : <AIBOX_ROOT>/roles.json (écrit par le dashboard,
# clikinfo). Les routes d'écriture exigent que l'utilisateur courant soit admin.
#
# ─────────────────────────────────────────────────────────────────────────────
# LIMITE DE SÉCURITÉ RÉSIDUELLE (à connaître — NON corrigeable dans ce fichier)
# ─────────────────────────────────────────────────────────────────────────────
# Tous les dashboards Hermes tournent sous le MÊME compte Unix (User=clikinfo)
# sur des ports loopback prévisibles. Un employé « client » qui obtient un shell
# sur la machine (ou qui devine le port du dashboard admin) peut, au niveau OS,
# lire/écrire roles.json et parler à n'importe quel dashboard : le contrôle de
# rôle ci-dessous s'appuie sur l'identité HERMES_HOME du process, PAS sur une
# frontière d'isolation renforcée par le noyau. La vraie mitigation est
# architecturale : 1 utilisateur Unix (voire 1 conteneur) par employé, avec des
# permissions filesystem strictes sur roles.json. Ce module durcit ce qui est
# durcissable à son niveau (fail-closed, écriture atomique, validation d'entrée)
# mais ne remplace PAS l'isolation OS manquante.
import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

log = logging.getLogger("aibox.rights")


class RolesCorrupt(Exception):
    """roles.json existe mais est illisible/invalide.

    On NE rétrograde PAS tout le monde en « client » (ni ne promeut personne) :
    on lève cette erreur pour que l'appelant échoue de façon fermée (fail-closed)
    plutôt que de renvoyer un état de rôles vide qui déverrouillerait/verrouillerait
    silencieusement les mauvaises personnes.
    """


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
    # HERMES_HOME = <root>/companies/<co>/users/<user>/hermes
    # <root> = l'ancêtre qui CONTIENT un sous-dossier « companies ». On ancre sur
    # cette STRUCTURE (déterministe) et non sur le NOM « aibox » : une entreprise
    # ou un user peut légitimement s'appeler « aibox » et fausserait la remontée.
    hh = _hermes_home()
    for anc in [hh, *hh.parents]:
        if (anc / "companies").is_dir():
            return anc
    # repli : structure attendue .../companies/<co>/users/<user>/hermes
    # → la racine est 5 niveaux au-dessus de HERMES_HOME (hermes, <user>, users,
    #   <co>, companies) ; parents[4] == le dossier qui contient « companies ».
    return hh.parents[4] if len(hh.parents) >= 5 else hh.parent


def _current_user() -> str:
    # HERMES_HOME = …/users/<user>/hermes → user = parent.name
    return _hermes_home().parent.name


def _roles_path() -> Path:
    return _aibox_root() / "roles.json"


def _load_roles() -> dict:
    p = _roles_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        # JSON invalide (write partiel, corruption disque, édition manuelle
        # foireuse). On NE renvoie PAS {} : cela rétrograderait tous les admins
        # en « client » (lockout admin, cf. incident). On lève une erreur claire.
        log.error("roles.json illisible (%s) : %s — refus fail-closed", p, exc)
        raise RolesCorrupt(f"roles.json invalide : {p}") from exc
    if not isinstance(data, dict):
        log.error("roles.json n'est pas un objet JSON (%s) : %r", p, type(data))
        raise RolesCorrupt(f"roles.json n'est pas un objet : {p}")
    return data


def _save_roles(d: dict) -> None:
    # Écriture ATOMIQUE : on écrit dans un fichier temporaire du même répertoire
    # puis os.replace() (rename atomique sur le même filesystem). Un crash au
    # milieu laisse l'ancien roles.json intact — jamais un JSON tronqué qui
    # rétrograderait tout le monde en « client ».
    p = _roles_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".tmp.{os.getpid()}")
    payload = json.dumps(d, ensure_ascii=False, indent=2)
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)          # atomique
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise


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
    # Fail-closed : toute indétermination (roles.json corrompu, erreur de lecture)
    # → on REFUSE. On ne veut jamais qu'une erreur ouvre l'accès admin.
    u = _current_user()
    try:
        role = _role_of(u)
    except RolesCorrupt as exc:
        raise HTTPException(
            status_code=503,
            detail="Rôles indisponibles (roles.json corrompu) — accès refusé.",
        ) from exc
    if role != "admin":
        raise HTTPException(status_code=403, detail="Réservé aux administrateurs.")
    return u


@router.get("/me")
async def me():
    # Fail-closed : si les rôles sont illisibles, on renvoie « client » (le moins
    # privilégié) plutôt que de propager une erreur qui pourrait être interprétée
    # à tort côté front. Le front (aibox.js) traite « client » comme vue réduite.
    u = _current_user()
    try:
        role = _role_of(u)
    except RolesCorrupt:
        role = "client"
    return {"user": u, "role": role}


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
    if role not in ("client", "admin"):
        raise HTTPException(status_code=400, detail="Paramètres invalides (role = client|admin).")
    # Valide que le user cible EXISTE réellement (dérivé du filesystem) : évite
    # les entrées fantômes (typo, user supprimé) et les tentatives d'injection de
    # chemin (« ../x », séparateurs) qui pollueraient roles.json.
    if not user or user not in _list_users():
        raise HTTPException(status_code=400, detail="Utilisateur cible inconnu.")
    roles = _load_roles()
    roles[user] = role
    _save_roles(roles)
    return {"ok": True, "user": user, "role": role}
