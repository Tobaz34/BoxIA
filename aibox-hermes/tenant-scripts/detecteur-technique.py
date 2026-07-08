#!/usr/bin/env python3
"""Detecteur SUPERVISION TECHNIQUE (lecture seule) - incidents + satisfaction + comm-gaps mail.
Sortie injectee dans le prompt de l'agent (skill aibox-responsable-technique). Aucun LLM ici.
Phases : 1a incidents/chatter, 4 satisfaction (ratings), 1b trous de comm (boites techniciens).
(Phases 2 projets / 3 planning : BLOQUEES - droits API Odoo insuffisants sur project.*)"""
import os, sys, json, time, subprocess
from datetime import datetime

HOME = os.environ.get("HERMES_HOME", "/home/clikinfo/aibox/companies/demo/users/andre/hermes")
CONNROOT = "/home/clikinfo/BoxIA/aibox-hermes/mcp-connectors"
CONN = CONNROOT + "/odoo"
STATE = os.path.join(HOME, "state", "tech_enriched.json")
STALE_DAYS = int(os.environ.get("AIBOX_TECH_STALE_DAYS", "7"))
WAIT_DAYS = int(os.environ.get("AIBOX_TECH_WAIT_DAYS", "3"))
COMM_DAYS = int(os.environ.get("AIBOX_TECH_COMM_DAYS", "2"))
RENUDGE_DAYS = 3
INTERNAL = ("clikinfo.fr", "xefi.fr")

import yaml
cfg = yaml.safe_load(open(os.path.join(HOME, "config.yaml"))) or {}
MS = cfg.get("mcp_servers") or {}
odoo = MS.get("odoo")
if not odoo:
    sys.exit(0)
oenv = dict(os.environ)
oenv.update({k: str(v) for k, v in (odoo.get("env") or {}).items()})


def _run(pydir, env, snip, timeout=60):
    try:
        out = subprocess.run([pydir + "/.venv/bin/python", "-c", snip], env=env,
                             capture_output=True, text=True, timeout=timeout)
        return json.loads(out.stdout.strip() or "null")
    except Exception:
        return None


def odoo_sr(model, domain, fields, limit=300, order=""):
    snip = ("import json,sys\n"
            "sys.path.insert(0," + repr(CONN) + ")\nimport server\n"
            "fn=getattr(server.odoo_search_read,'fn',server.odoo_search_read)\n"
            "print(json.dumps(fn(model=" + repr(model) + ",domain=" + repr(domain) +
            ",fields=" + repr(fields) + ",limit=" + str(limit) + ",order=" + repr(order) + "),default=str))\n")
    return _run(CONN, oenv, snip) or []


def m2o(v):
    return v[1] if isinstance(v, list) and len(v) > 1 else None


def m2o_id(v):
    return v[0] if isinstance(v, list) and v else None


def days_since(s):
    if not s:
        return None
    try:
        return (datetime.now() - datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")).days
    except Exception:
        return None


# ---------- ROSTER dynamique ----------
team = odoo_sr("helpdesk.team", [["name", "=", "Technique"]], ["member_ids"], 1)
member_ids = [i for i in ((team[0].get("member_ids") if team else []) or []) if i not in (1, 2)]
if not member_ids:
    tk = odoo_sr("helpdesk.ticket", [["team_id.name", "=", "Technique"]], ["user_id", "write_date"], 400, "write_date desc")
    member_ids = list({m2o_id(t["user_id"]) for t in tk if t.get("user_id") and m2o_id(t["user_id"]) not in (1, 2)})
users = odoo_sr("res.users", [["id", "in", member_ids], ["active", "=", True]], ["name", "email"], 100) if member_ids else []
roster = {u["id"]: {"name": u["name"], "email": (u.get("email") or "").lower()} for u in users}

# ---------- 1a INCIDENTS ----------
tickets = odoo_sr("helpdesk.ticket", [["team_id.name", "=", "Technique"], ["stage_id.fold", "=", False]],
                  ["name", "user_id", "partner_id", "stage_id", "priority", "date_last_stage_update", "sla_fail",
                   "rating_last_value", "oldest_unanswered_customer_message_date", "partner_open_ticket_count"],
                  300, "date_last_stage_update asc")


def flags(t):
    f = []
    d = days_since(t.get("date_last_stage_update"))
    if d is not None and d > STALE_DAYS:
        f.append("stale " + str(d) + "j")
    if t.get("sla_fail"):
        f.append("SLA depasse")
    wd = days_since(t.get("oldest_unanswered_customer_message_date"))
    if wd is not None and wd >= WAIT_DAYS:
        f.append("client en attente " + str(wd) + "j")
    if not t.get("user_id"):
        f.append("NON ASSIGNE")
    if (t.get("partner_open_ticket_count") or 0) > 1:
        f.append("rebond (" + str(t["partner_open_ticket_count"]) + " tickets ouverts)")
    if (t.get("rating_last_value") or 0) in (1.0, 2.0):
        f.append("client mecontent (" + str(int(t["rating_last_value"])) + " etoiles)")
    return f


try:
    seen = json.load(open(STATE))
except Exception:
    seen = {}
now = time.time()
at_risk = []
for t in tickets:
    fl = flags(t)
    if not fl:
        continue
    tid = str(t["id"])
    new = (tid not in seen) or (now - seen.get(tid, 0) > RENUDGE_DAYS * 86400)
    if new:
        seen[tid] = now
    at_risk.append((t, fl, new))


def _score(item):
    t, fl, new = item
    sc = 0
    for x in fl:
        if ("SLA" in x) or ("attente" in x) or ("mecontent" in x):
            sc += 3
        elif ("stale" in x) or ("NON ASSIGN" in x) or ("rebond" in x):
            sc += 2
    return sc


at_risk.sort(key=_score, reverse=True)
_total = len(at_risk)
CAP = int(os.environ.get("AIBOX_TECH_CAP", "8"))
at_risk = at_risk[:CAP]
json.dump(seen, open(STATE, "w"))

# ---------- 4 SATISFACTION ----------
low_ratings = []
try:
    rr = odoo_sr("rating.rating", [["res_model", "=", "helpdesk.ticket"], ["rating", ">", 0], ["rating", "<=", 2]],
                 ["rating", "res_name", "feedback", "create_date"], 10, "create_date desc")
    low_ratings = [r for r in rr if (days_since(r.get("create_date")) or 999) <= 14]
except Exception:
    pass

# ---------- 1b COMM-GAPS (boites techniciens clikinfo) ----------
commgaps = []
msenv = (MS.get("email-msgraph") or {}).get("env") or {}
if msenv:
    for uid, info in roster.items():
        mb = info["email"]
        if not mb.endswith("@clikinfo.fr"):
            continue
        env = dict(os.environ)
        env.update({k: str(v) for k, v in msenv.items()})
        env["MSGRAPH_ALLOWED_MAILBOXES"] = mb
        snip = ("import json,sys\n"
                "sys.path.insert(0," + repr(CONNROOT + "/email-msgraph") + ")\nimport server\n"
                "fn=getattr(server.list_recent_emails,'fn',server.list_recent_emails)\n"
                "print(json.dumps(fn(mailbox=" + repr(mb) + ",limit=25,unread_only=True),default=str))\n")
        res = _run(CONNROOT + "/email-msgraph", env, snip, timeout=40) or []
        ext = []
        for m in res:
            frm = str(m.get("from") or "").lower()
            if not frm or any(d in frm for d in INTERNAL):
                continue
            age = days_since(m.get("received"))
            if age is not None and age >= COMM_DAYS:
                ext.append((frm, (m.get("subject") or "")[:50], age))
        if ext:
            ext.sort(key=lambda x: -x[2])
            commgaps.append((info["name"], len(ext), ext[:3]))

# ---------- SORTIE ----------
if not (at_risk or low_ratings or commgaps):
    sys.exit(0)
print("SUPERVISION TECHNIQUE - " + datetime.now().strftime("%d/%m %H:%M"))
noms = ", ".join(i["name"] for i in roster.values()) or "(roster vide - peupler equipe Technique Odoo)"
print("Equipe suivie : " + noms + "\n")
if at_risk:
    print("### INCIDENTS A RISQUE (" + str(_total) + ", top " + str(len(at_risk)) + ") - applique le skill aibox-responsable-technique")
    from collections import defaultdict
    g = defaultdict(list)
    for t, fl, new in at_risk:
        g[m2o(t.get("user_id")) or "NON ASSIGNE"].append((t, fl, new))
    for who, items in sorted(g.items(), key=lambda kv: ("0" if kv[0] == "NON ASSIGNE" else kv[0])):
        print("[" + who + "]")
        for t, fl, new in items:
            tag = " -> ENRICHIR (nouveau)" if new else ""
            print("  #" + str(t["id"]) + " " + (t.get("name", "")[:60]) + " - client " + str(m2o(t.get("partner_id")) or "?") + " - " + " ; ".join(fl) + tag)
    print()
if low_ratings:
    print("### SATISFACTION - " + str(len(low_ratings)) + " avis negatif(s) recent(s)")
    for r in low_ratings:
        print("  " + str(int(r["rating"])) + " etoiles " + str(r.get("res_name", "")) + " - " + (str(r.get("feedback") or "").strip()[:80]))
    print()
if commgaps:
    print("### TROUS DE COMMUNICATION (mails externes non lus > " + str(COMM_DAYS) + "j dans les boites techniciens)")
    for name, n, ex in commgaps:
        print("  " + name + " : " + str(n) + " mail(s) externe(s) en attente")
        for frm, subj, age in ex:
            print("     - " + frm + " " + subj + " (" + str(age) + "j)")
    print()
