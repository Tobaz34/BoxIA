# Backend du plugin « Connexions » (inventaire des intégrations AI Box).
# Routes montées sous /api/plugins/aibox-connections/. Tourne dans le process du
# dashboard de l'utilisateur courant (un par user) → identité = HERMES_HOME.
#
# Deux temps, pour une UI instantanée sans probe réseau bloquante :
#   GET /inventory        → liste des intégrations + état CONFIGURÉ (instantané,
#                           lecture de config.yaml / .env / config himalaya).
#   GET /check/{id}        → test de connexion LIVE d'UNE intégration (à la
#                           demande, borné par timeout). Jamais au chargement.
#
# Ne renvoie JAMAIS de secret : uniquement noms, catégories, booléens d'état et
# résultats de test (ok / message court / latence).
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

# PATH enrichi pour retrouver himalaya (~/.local/bin) depuis le process dashboard.
_ENV_PATH = os.pathsep.join([
    str(Path.home() / ".local" / "bin"),
    "/usr/local/bin", "/usr/bin", "/bin",
    os.environ.get("PATH", ""),
])


def _hermes_home() -> Path:
    hh = os.environ.get("HERMES_HOME", "")
    if not hh:
        try:
            from hermes_cli.web_server import get_hermes_home
            hh = str(get_hermes_home())
        except Exception:
            hh = str(Path.home() / ".hermes")
    return Path(hh)


def _read_env() -> dict:
    """Parse HERMES_HOME/.env en dict SANS exposer les valeurs (présence seule)."""
    env = {}
    p = _hermes_home() / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def _config_text() -> str:
    p = _hermes_home() / "config.yaml"
    return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""


def _mcp_servers() -> set:
    """Noms des serveurs MCP déclarés (parse tolérant du bloc mcp_servers)."""
    txt = _config_text()
    names = set()
    in_block = False
    for line in txt.splitlines():
        if re.match(r"^mcp_servers:", line):
            in_block = True
            continue
        if in_block:
            if re.match(r"^\S", line):        # fin du bloc (désindenté)
                break
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if m:
                names.add(m.group(1))
    return names


def _himalaya_accounts() -> list:
    """[(compte, adresse, pass_present)] depuis ~/.config/himalaya/config.toml."""
    cfg = Path.home() / ".config" / "himalaya" / "config.toml"
    out = []
    if not cfg.exists():
        return out
    txt = cfg.read_text(encoding="utf-8", errors="replace")
    cur = None
    email = None
    for line in txt.splitlines():
        m = re.match(r"^\[accounts\.([A-Za-z0-9_-]+)\]", line.strip())
        if m:
            if cur:
                out.append((cur, email))
            cur = m.group(1)
            email = None
        elif cur and email is None:
            me = re.match(r'^\s*email\s*=\s*"([^"]+)"', line)
            if me:
                email = me.group(1)
    if cur:
        out.append((cur, email))
    # état du mot de passe : fichier <compte>.pass non vide
    res = []
    for acct, mail in out:
        pw = cfg.parent / f"{acct}.pass"
        has_pw = pw.exists() and pw.stat().st_size > 0
        res.append((acct, mail, has_pw))
    return res


def _connector_python(name: str) -> str | None:
    """Chemin du python du venv d'un connecteur MCP, extrait de config.yaml.

    Parsing ligne par ligne (robuste) : on repère la ligne `  <name>:` puis on
    lit la 1re ligne `command: "..."` du bloc indenté qui suit.
    """
    lines = _config_text().splitlines()
    in_srv = False
    for line in lines:
        if re.match(rf"^  {re.escape(name)}:\s*$", line):
            in_srv = True
            continue
        if in_srv:
            if re.match(r"^  \S", line):    # début d'un autre serveur (2 espaces)
                break
            # valeur avec ou SANS guillemets (Hermes réécrit le YAML sans quotes)
            m = re.search(r'command:\s*(.+?)\s*$', line)
            if m:
                return m.group(1).strip().strip("'\"")
    return None


# ── Inventaire (instantané) ──────────────────────────────────────────────────
def _build_inventory() -> list:
    env = _read_env()
    mcp = _mcp_servers()
    items = []

    # 1. Boîtes email IMAP (himalaya : gmail, ridequest…)
    for acct, mail, has_pw in _himalaya_accounts():
        items.append({
            "id": f"himalaya:{acct}",
            "category": "Email",
            "label": mail or acct,
            "kind": "IMAP",
            "configured": bool(has_pw),
            "detail": "IMAP/SMTP" + ("" if has_pw else " — mot de passe manquant"),
            "checkable": has_pw,
        })

    # 2. Boîtes Microsoft 365 (connecteur email-msgraph, allowlist)
    if "email-msgraph" in mcp:
        ok = all(env.get(k) for k in ("MSGRAPH_TENANT_ID", "MSGRAPH_CLIENT_ID", "MSGRAPH_CLIENT_SECRET"))
        mailboxes = [m.strip() for m in env.get("MSGRAPH_ALLOWED_MAILBOXES", "").split(",") if m.strip()]
        for mb in (mailboxes or ["(aucune boîte autorisée)"]):
            items.append({
                "id": f"msgraph:{mb}",
                "category": "Email",
                "label": mb,
                "kind": "Microsoft 365",
                "configured": ok and bool(mailboxes),
                "detail": "Microsoft Graph (app-only)",
                "checkable": ok and bool(mailboxes),
            })

    # 3. Boîte Exchange on-premise (connecteur email-ews)
    if "email-ews" in mcp:
        ok = all(env.get(k) for k in ("EWS_EMAIL", "EWS_PASSWORD"))
        items.append({
            "id": "ews",
            "category": "Email",
            "label": env.get("EWS_EMAIL", "Exchange on-premise"),
            "kind": "Exchange (EWS)",
            "configured": ok,
            "detail": "Exchange Web Services / NTLM",
            "checkable": ok,
        })

    # 4. Autres connecteurs MCP RÉELLEMENT déclarés (hors email, déjà traités).
    #    Métadonnées d'affichage pour ceux qu'on connaît ; générique sinon.
    #    → on n'affiche QUE ce qui est effectivement dans la config (pas de
    #      catalogue codé en dur : si un connecteur n'est pas là, il n'apparaît pas).
    meta = {
        "pennylane": ("Comptabilité", "Pennylane", "Factures / clients"),
        "odoo": ("ERP / CRM", "Odoo", "ERP"),
        "sharepoint": ("Documents", "SharePoint / OneDrive", "Microsoft 365"),
        "glpi": ("Support IT", "GLPI", "Tickets IT"),
        "fec": ("Comptabilité", "FEC", "Écritures comptables"),
    }
    for name in sorted(mcp):
        if name in ("email-msgraph", "email-ews"):
            continue  # déjà rendus comme boîtes email
        cat, label, kind = meta.get(name, ("Connecteurs", name, "Serveur MCP"))
        items.append({
            "id": name,
            "category": cat,
            "label": label,
            "kind": kind,
            "configured": True,
            "detail": "Connecteur MCP",
            "checkable": True,
        })

    # 5. Suggestions « disponibles » : uniquement des intégrations pertinentes non
    #    encore branchées (Odoo, SharePoint). Masquées dès qu'elles sont configurées.
    for iid, cat, label, kind in [
        ("odoo", "ERP / CRM", "Odoo", "ERP"),
        ("sharepoint", "Documents", "SharePoint / OneDrive", "Microsoft 365"),
    ]:
        if iid in mcp:
            continue
        items.append({
            "id": iid,
            "category": cat,
            "label": label,
            "kind": kind,
            "configured": False,
            "detail": "Disponible — non configuré",
            "checkable": False,
        })

    return items


# ── Tests de connexion (à la demande, bornés) ────────────────────────────────
def _run(cmd: list, timeout: int = 20, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PATH"] = _ENV_PATH
    if extra_env:
        env.update(extra_env)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def _check_himalaya(acct: str) -> dict:
    hima = shutil.which("himalaya", path=_ENV_PATH)
    if not hima:
        return {"ok": False, "message": "himalaya introuvable"}
    r = _run([hima, "folder", "list", "-a", acct], timeout=25)
    if r.returncode == 0:
        n = sum(1 for ln in r.stdout.splitlines() if ln.strip().startswith("|")) - 1
        return {"ok": True, "message": f"connecté — {max(n,0)} dossier(s)"}
    err = (r.stderr or r.stdout or "").strip().splitlines()
    return {"ok": False, "message": (err[-1][:140] if err else "échec de connexion")}


def _check_connector(name: str, snippet: str) -> dict:
    """Exécute un petit script Python dans le venv du connecteur MCP."""
    py = _connector_python(name)
    if not py or not Path(py).exists():
        return {"ok": False, "message": f"venv du connecteur {name} introuvable"}
    # .../<name>/.venv/bin/python → parents: [0]=bin [1]=.venv [2]=<name> (server.py)
    conn_dir = str(Path(py).parents[2])
    code = f"import sys; sys.path.insert(0, {conn_dir!r})\n" + snippet
    # Le connecteur lit ses secrets dans l'environnement : Hermes les injecte via
    # le bloc `env:` de config.yaml (${env:X} résolu depuis .env). Notre test doit
    # faire pareil — on charge le .env de HERMES_HOME et on le passe au sous-process.
    try:
        r = _run([py, "-c", code], timeout=25, extra_env=_read_env())
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "timeout (serveur injoignable ?)"}
    out = (r.stdout or "").strip()
    if r.returncode == 0 and out.startswith("OK"):
        return {"ok": True, "message": out[3:].strip() or "connecté"}
    msg = (r.stderr or out or "").strip().splitlines()
    return {"ok": False, "message": (msg[-1][:140] if msg else "échec")}


def _check(iid: str) -> dict:
    if iid.startswith("himalaya:"):
        return _check_himalaya(iid.split(":", 1)[1])
    if iid.startswith("msgraph:"):
        mb = iid.split(":", 1)[1]
        snip = (
            "import server\n"
            "fn=getattr(server.list_recent_emails,'fn',server.list_recent_emails)\n"
            f"m=fn({mb!r}, limit=1)\n"
            "print('OK', 'boîte accessible')\n"
        )
        return _check_connector("email-msgraph", snip)
    if iid == "ews":
        snip = (
            "import server\n"
            "h=getattr(server.ews_email_health,'fn',server.ews_email_health)()\n"
            "print('OK', 'INBOX', h.get('inbox_total'))\n"
        )
        return _check_connector("email-ews", snip)
    if iid == "pennylane":
        snip = (
            "import server\n"
            "h=getattr(server.pennylane_health,'fn',server.pennylane_health)()\n"
            "print('OK', 'service joignable')\n"
        )
        return _check_connector("pennylane", snip)
    raise HTTPException(status_code=404, detail="Intégration inconnue ou non testable.")


@router.get("/inventory")
async def inventory():
    items = _build_inventory()
    cats: dict = {}
    for it in items:
        cats.setdefault(it["category"], []).append(it)
    n_ok = sum(1 for it in items if it["configured"])
    return {
        "summary": {"total": len(items), "configured": n_ok},
        "categories": [{"name": k, "items": v} for k, v in cats.items()],
    }


@router.get("/check/{iid:path}")
async def check(iid: str):
    t0 = time.time()
    try:
        res = _check(iid)
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        res = {"ok": False, "message": "timeout"}
    except Exception as exc:
        res = {"ok": False, "message": f"erreur: {str(exc)[:120]}"}
    res["latency_ms"] = int((time.time() - t0) * 1000)
    res["id"] = iid
    return res
