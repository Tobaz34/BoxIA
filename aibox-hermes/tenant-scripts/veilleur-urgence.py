#!/usr/bin/env python3
"""Veilleur d'urgence email — alerte Telegram quasi temps-reel.
Lit les non-lus de TOUTES les boites (msgraph/ews/himalaya) via chaque connecteur,
score avec urgency.py, dedup, n'emet que le NEUF. VIP = clients Odoo (seuil abaisse
a 'moyenne' pour eux). stdout vide => cron silencieux. Aucun LLM."""
import os, sys, json, time, subprocess, re

HOME = os.environ.get("HERMES_HOME", "/home/clikinfo/aibox/companies/demo/users/andre/hermes")
CONN = "/home/clikinfo/BoxIA/aibox-hermes/mcp-connectors"
URG  = "/home/clikinfo/BoxIA/aibox-hermes/skills/aibox-email-triage"
STATE = os.path.join(HOME, "state", "veilleur_seen.json")
LEVEL_MIN = os.environ.get("AIBOX_URGENT_LEVEL", "haute")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
sys.path.insert(0, URG)
try:
    from urgency import score_urgency
except Exception:
    def score_urgency(subject="", body="", sender="", vips=None): return {"level":"basse","score":0,"reasons":[]}

import yaml
cfg = yaml.safe_load(open(os.path.join(HOME, "config.yaml"))) or {}
MS = cfg.get("mcp_servers") or {}
STATIC_VIPS = [v.strip().lower() for v in os.environ.get("AIBOX_VIP_SENDERS", "").split(",") if v.strip()]

def _conn_env(name):
    env = dict(os.environ)
    env.update({k: str(v) for k, v in ((MS.get(name) or {}).get("env") or {}).items()})
    return env

def _run(name, snippet, timeout=45):
    py = f"{CONN}/{name}/.venv/bin/python"
    try:
        out = subprocess.run([py, "-c", snippet], env=_conn_env(name),
                             capture_output=True, text=True, timeout=timeout)
        if out.returncode != 0: return None
        return json.loads(out.stdout.strip() or "null")
    except Exception:
        return None

def fetch(name, call):
    snip = ("import json,sys\n"
            f"sys.path.insert(0,'{CONN}/{name}')\nimport server\n"
            "fn=getattr(server.list_recent_emails,'fn',server.list_recent_emails)\n"
            f"print(json.dumps({call}, default=str))\n")
    return _run(name, snip) or []

def addr_of(m):
    frm = str(m.get("from") or m.get("sender") or m.get("from_address") or "")
    mm = EMAIL_RE.search(frm)
    return (mm.group(0).lower() if mm else frm.lower())

def clients_among(addrs):
    """Interroge Odoo : lesquels de ces emails sont des CLIENTS (customer_rank>0) ?"""
    if not addrs or not (MS.get("odoo") or {}).get("env"): return set()
    snip = ("import json,sys\n"
            f"sys.path.insert(0,'{CONN}/odoo')\nimport server\n"
            "fn=getattr(server.odoo_search_read,'fn',server.odoo_search_read)\n"
            f"res=fn(model='res.partner', domain=[['email','in',{json.dumps(sorted(addrs))}],['customer_rank','>',0]], fields=['email'], limit=200)\n"
            "print(json.dumps([ (r.get('email') or '').lower() for r in res if r.get('email') ]))\n")
    got = _run("odoo", snip)
    return set(got) if isinstance(got, list) else set()

# --- Collecte de toutes les boites ---
emails = []
msenv = (MS.get("email-msgraph") or {}).get("env") or {}
for mb in (msenv.get("MSGRAPH_ALLOWED_MAILBOXES", "") or "").split(","):
    mb = mb.strip()
    if mb:
        for m in fetch("email-msgraph", f"fn(mailbox={mb!r}, limit=25, unread_only=True)"): emails.append((mb, m))
ewsenv = (MS.get("email-ews") or {}).get("env") or {}
if ewsenv:
    for m in fetch("email-ews", "fn(limit=25, unread_only=True)"): emails.append((ewsenv.get("EWS_EMAIL","xefi"), m))
himenv = (MS.get("himalaya") or {}).get("env") or {}
for acc in (himenv.get("HIMALAYA_ACCOUNTS", "") or "").split(","):
    acc = acc.strip()
    if acc:
        for m in fetch("himalaya", f"fn(account={acc!r}, limit=25, unread_only=True)"): emails.append((acc, m))

# --- VIP = clients Odoo (1 requete batch) ---
addrs = {addr_of(m) for _, m in emails if addr_of(m)}
client_set = clients_among(addrs)

# --- State (dedup) ---
try: seen = json.load(open(STATE))
except Exception: seen = {}
now = time.time()
seen = {k: v for k, v in seen.items() if now - v < 14*86400}

def field(m, *keys):
    for k in keys:
        v = m.get(k)
        if v: return v
    return ""

RANK = {"basse":0, "moyenne":1, "haute":2}
alerts = []
for box, m in emails:
    a = addr_of(m)
    is_vip = (a in client_set) or any(v in a for v in STATIC_VIPS)
    mid = str(field(m, "id", "message_id", "item_id") or (field(m, "subject") + field(m, "received")))
    key = f"{box}:{mid}"
    subject = str(field(m, "subject")); frm = str(field(m, "from", "sender")); prev = str(field(m, "preview", "body_preview", "snippet", "body"))
    sc = score_urgency(subject, prev, frm, list(client_set) + STATIC_VIPS)
    thr = "moyenne" if is_vip else LEVEL_MIN   # clients = plus sensible
    if RANK.get(sc["level"], 0) < RANK.get(thr, 2): continue
    if key in seen: continue
    seen[key] = now
    reason = (sc.get("reasons") or (["client"] if is_vip else ["urgent"]))[0]
    tag = " · CLIENT" if is_vip else ""
    alerts.append(f"🔴 URGENT{tag} · {box}\n   de {frm[:50]}\n   « {subject[:90]} »\n   ({reason}, score {sc['score']})")

json.dump(seen, open(STATE, "w"))
if alerts:
    print("⚠️ Email(s) à traiter en priorité :\n")
    print("\n\n".join(alerts))
    print("\n→ À traiter en priorité. Réponds à ce message pour que je m'en occupe.")
