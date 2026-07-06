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


def _set_env(key: str, value: str) -> None:
    """Écrit/met à jour KEY='value' dans HERMES_HOME/.env (édition ligne par ligne,
    préserve le reste du fichier). Backup .env.bak avant écriture."""
    p = _hermes_home() / ".env"
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines() if p.exists() else []
    out, found = [], False
    for line in lines:
        if re.match(rf"^{re.escape(key)}=", line.strip()):
            out.append(f"{key}='{value}'")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}='{value}'")
    if p.exists():
        try:
            p.with_suffix(".env.bak").write_text("\n".join(lines) + "\n", encoding="utf-8")
        except Exception:
            pass
    tmp = p.with_name(p.name + f".tmp.{os.getpid()}")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def _get_env(key: str, default: str = "") -> str:
    return _read_env().get(key, default)


def _himalaya_dir() -> Path:
    return Path.home() / ".config" / "himalaya"


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


def _connector_env(name: str) -> dict:
    """Env d'un connecteur MCP, comme Hermes l'injecte : lit le bloc `env:` du
    serveur dans config.yaml ; ${env:X} est résolu depuis .env, sinon valeur
    littérale (cas des connecteurs configurés via l'UI, ex. Odoo)."""
    lines = _config_text().splitlines()
    dotenv = _read_env()
    out: dict = {}
    in_srv = in_env = False
    for line in lines:
        if re.match(rf"^  {re.escape(name)}:\s*$", line):
            in_srv = True
            continue
        if in_srv:
            if re.match(r"^  \S", line):        # autre serveur → fin
                break
            if re.match(r"^    env:\s*$", line):
                in_env = True
                continue
            if in_env:
                if re.match(r"^    \S", line) and not re.match(r"^      ", line):
                    in_env = False                # fin du bloc env
                    continue
                m = re.match(r"^      ([A-Za-z0-9_]+):\s*(.*)$", line)
                if m:
                    k, v = m.group(1), m.group(2).strip().strip("'\"")
                    ph = re.match(r"^\$\{env:([A-Za-z0-9_]+)\}$", v)
                    out[k] = dotenv.get(ph.group(1), "") if ph else v
    return out


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
    #    Désactivée = fichier <compte>.pass renommé en <compte>.pass.off (réversible).
    hdir = _himalaya_dir()
    for acct, mail, has_pw in _himalaya_accounts():
        disabled = (hdir / f"{acct}.pass.off").exists() and not has_pw
        enabled = bool(has_pw)
        items.append({
            "id": f"himalaya:{acct}",
            "category": "Email",
            "label": mail or acct,
            "kind": "IMAP",
            "configured": enabled or disabled,
            "enabled": enabled,
            "disabled": disabled,
            "detail": "IMAP/SMTP" + ("" if (enabled or disabled) else " — mot de passe manquant"),
            "checkable": enabled,
            "actions": ["toggle", "set_password"],
        })

    # 2. Boîtes Microsoft 365 (connecteur email-msgraph, allowlist).
    #    Désactiver une boîte = la déplacer de MSGRAPH_ALLOWED_MAILBOXES vers
    #    MSGRAPH_DISABLED_MAILBOXES (réversible). Auth = app Entra (pas de mdp/boîte).
    if "email-msgraph" in mcp:
        ok = all(env.get(k) for k in ("MSGRAPH_TENANT_ID", "MSGRAPH_CLIENT_ID", "MSGRAPH_CLIENT_SECRET"))
        allowed = [m.strip() for m in env.get("MSGRAPH_ALLOWED_MAILBOXES", "").split(",") if m.strip()]
        disabled_l = [m.strip() for m in env.get("MSGRAPH_DISABLED_MAILBOXES", "").split(",") if m.strip()]
        for mb in allowed:
            items.append({
                "id": f"msgraph:{mb}", "category": "Email", "label": mb, "kind": "Microsoft 365",
                "configured": ok, "enabled": ok, "disabled": False,
                "detail": "Microsoft Graph (app-only)", "checkable": ok, "actions": ["toggle"],
            })
        for mb in disabled_l:
            items.append({
                "id": f"msgraph:{mb}", "category": "Email", "label": mb, "kind": "Microsoft 365",
                "configured": True, "enabled": False, "disabled": True,
                "detail": "Microsoft Graph (app-only)", "checkable": False, "actions": ["toggle"],
            })

    # 3. Boîte Exchange on-premise (connecteur email-ews).
    #    Désactiver = déplacer EWS_PASSWORD → EWS_PASSWORD_OFF (réversible).
    if "email-ews" in mcp:
        has_pw = bool(env.get("EWS_PASSWORD"))
        disabled = (not has_pw) and bool(env.get("EWS_PASSWORD_OFF"))
        items.append({
            "id": "ews", "category": "Email",
            "label": env.get("EWS_EMAIL", "Exchange on-premise"), "kind": "Exchange (EWS)",
            "configured": has_pw or disabled, "enabled": has_pw, "disabled": disabled,
            "detail": "Exchange Web Services / NTLM", "checkable": has_pw,
            "actions": ["toggle", "set_password"],
        })

    # 4. Autres connecteurs MCP RÉELLEMENT déclarés (hors email, déjà traités).
    #    Métadonnées d'affichage pour ceux qu'on connaît ; générique sinon.
    #    → on n'affiche QUE ce qui est effectivement dans la config (pas de
    #      catalogue codé en dur : si un connecteur n'est pas là, il n'apparaît pas).
    meta = {
        "pennylane": ("Comptabilité", "Pennylane", "Factures / clients"),
        "odoo": ("ERP / CRM", "Odoo", "ERP"),
        "msfiles": ("Documents", "SharePoint / OneDrive", "Microsoft 365"),
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
        # SharePoint est fourni par le connecteur 'msfiles' → ne pas re-suggérer.
        if iid == "sharepoint" and "msfiles" in mcp:
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
        # env comme Hermes l'injecte : .env + bloc env: du connecteur dans config.yaml
        env = _read_env()
        env.update(_connector_env(name))
        r = _run([py, "-c", code], timeout=25, extra_env=env)
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
    if iid == "odoo":
        snip = (
            "import server\n"
            "h=getattr(server.odoo_health,'fn',server.odoo_health)()\n"
            "print('OK', 'Odoo', h.get('server_version'))\n"
        )
        return _check_connector("odoo", snip)
    if iid == "msfiles":
        snip = (
            "import server\n"
            "h=getattr(server.msfiles_health,'fn',server.msfiles_health)()\n"
            "print('OK', 'site:', h.get('sample_site'))\n"
        )
        return _check_connector("msfiles", snip)
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


# ── Gestion par boîte : désactiver/réactiver (réversible) + changer le mot de passe ──
# needs_reconnect=True → le connecteur MCP lit ses variables au démarrage ; le
# front rebondit le serveur via l'API native de hermes-webui pour appliquer.
def _csv(v: str) -> list:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def _manage_himalaya(acct: str, action: str, value: str | None) -> dict:
    hdir = _himalaya_dir()
    pw, off = hdir / f"{acct}.pass", hdir / f"{acct}.pass.off"
    if action == "disable":
        if pw.exists():
            os.replace(pw, off)
        return {"ok": True, "message": "boîte désactivée", "needs_reconnect": False}
    if action == "enable":
        if off.exists():
            os.replace(off, pw)
        return {"ok": True, "message": "boîte réactivée", "needs_reconnect": False}
    if action == "set_password":
        if not value:
            raise HTTPException(status_code=400, detail="Mot de passe vide.")
        tmp = hdir / f"{acct}.pass.tmp.{os.getpid()}"
        tmp.write_text(value, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, pw)
        if off.exists():
            off.unlink()
        return {"ok": True, "message": "mot de passe mis à jour", "needs_reconnect": False}
    raise HTTPException(status_code=400, detail="Action inconnue.")


def _manage_msgraph(mb: str, action: str, value: str | None) -> dict:
    allowed = _csv(_get_env("MSGRAPH_ALLOWED_MAILBOXES"))
    disabled = _csv(_get_env("MSGRAPH_DISABLED_MAILBOXES"))
    if action == "disable":
        if mb in allowed:
            allowed.remove(mb)
        if mb not in disabled:
            disabled.append(mb)
    elif action == "enable":
        if mb in disabled:
            disabled.remove(mb)
        if mb not in allowed:
            allowed.append(mb)
    else:
        raise HTTPException(status_code=400, detail="Les boîtes Microsoft 365 utilisent l'auth par application (pas de mot de passe par boîte).")
    _set_env("MSGRAPH_ALLOWED_MAILBOXES", ",".join(allowed))
    _set_env("MSGRAPH_DISABLED_MAILBOXES", ",".join(disabled))
    return {"ok": True, "message": "état mis à jour", "needs_reconnect": True, "connector": "email-msgraph"}


def _manage_ews(action: str, value: str | None) -> dict:
    if action == "disable":
        cur = _get_env("EWS_PASSWORD")
        if cur:
            _set_env("EWS_PASSWORD_OFF", cur)
            _set_env("EWS_PASSWORD", "")
        return {"ok": True, "message": "boîte désactivée", "needs_reconnect": True, "connector": "email-ews"}
    if action == "enable":
        off = _get_env("EWS_PASSWORD_OFF")
        if off:
            _set_env("EWS_PASSWORD", off)
            _set_env("EWS_PASSWORD_OFF", "")
        return {"ok": True, "message": "boîte réactivée", "needs_reconnect": True, "connector": "email-ews"}
    if action == "set_password":
        if not value:
            raise HTTPException(status_code=400, detail="Mot de passe vide.")
        _set_env("EWS_PASSWORD", value)
        _set_env("EWS_PASSWORD_OFF", "")
        # miroir dans le fichier partagé xefi.pass (source utilisée au provisioning)
        try:
            (_himalaya_dir() / "xefi.pass").write_text(value, encoding="utf-8")
        except Exception:
            pass
        return {"ok": True, "message": "mot de passe mis à jour", "needs_reconnect": True, "connector": "email-ews"}
    raise HTTPException(status_code=400, detail="Action inconnue.")


@router.post("/manage")
async def manage(body: dict):
    iid = str(body.get("id", "")).strip()
    action = str(body.get("action", "")).strip()
    value = body.get("value")
    if action not in ("enable", "disable", "set_password"):
        raise HTTPException(status_code=400, detail="Action invalide.")
    if iid.startswith("himalaya:"):
        return _manage_himalaya(iid.split(":", 1)[1], action, value)
    if iid.startswith("msgraph:"):
        return _manage_msgraph(iid.split(":", 1)[1], action, value)
    if iid == "ews":
        return _manage_ews(action, value)
    raise HTTPException(status_code=404, detail="Boîte inconnue ou non gérable.")
