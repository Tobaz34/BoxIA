#!/usr/bin/env python3
"""Détecteur SUPERVISION TECHNIQUE (lecture seule) — roster dynamique + tickets à risque.
Sortie injectée dans le prompt de l'agent (skill aibox-responsable-technique). Aucun LLM ici."""
import os, sys, json, time, subprocess
from datetime import datetime

HOME = os.environ.get("HERMES_HOME", "/home/clikinfo/aibox/companies/demo/users/andre/hermes")
CONN = "/home/clikinfo/BoxIA/aibox-hermes/mcp-connectors/odoo"
STATE = os.path.join(HOME, "state", "tech_enriched.json")
STALE_DAYS = int(os.environ.get("AIBOX_TECH_STALE_DAYS", "7"))
WAIT_DAYS  = int(os.environ.get("AIBOX_TECH_WAIT_DAYS", "3"))
RENUDGE_DAYS = 3

import yaml
cfg = yaml.safe_load(open(os.path.join(HOME, "config.yaml"))) or {}
odoo = (cfg.get("mcp_servers") or {}).get("odoo")
if not odoo: sys.exit(0)
env = dict(os.environ); env.update({k: str(v) for k, v in (odoo.get("env") or {}).items()})

def odoo_sr(model, domain, fields, limit=300, order=""):
    snip = ("import json,sys\n"
            f"sys.path.insert(0,'{CONN}')\nimport server\n"
            "fn=getattr(server.odoo_search_read,'fn',server.odoo_search_read)\n"
            f"print(json.dumps(fn(model={model!r}, domain={domain!r}, fields={fields!r}, limit={limit}, order={order!r}), default=str))\n")
    try:
        out = subprocess.run([f"{CONN}/.venv/bin/python","-c",snip], env=env, capture_output=True, text=True, timeout=60)
        return json.loads(out.stdout.strip() or "[]")
    except Exception:
        return []

def m2o(v): return v[1] if isinstance(v, list) and len(v) > 1 else None
def m2o_id(v): return v[0] if isinstance(v, list) and v else None
def days_since(s):
    if not s: return None
    try: return (datetime.now() - datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")).days
    except Exception: return None

# --- Roster dynamique : équipe Technique (hors patron/bot) sinon assignés récents actifs ---
team = odoo_sr("helpdesk.team", [["name","=","Technique"]], ["member_ids"], 1)
member_ids = (team[0].get("member_ids") if team else []) or []
member_ids = [i for i in member_ids if i not in (1,2)]  # hors OdooBot(1) et André(2)
if len(member_ids) < 1:
    # repli : assignés de tickets Technique récents (90j)
    tk = odoo_sr("helpdesk.ticket", [["team_id.name","=","Technique"]], ["user_id","write_date"], 400, "write_date desc")
    member_ids = list({m2o_id(t["user_id"]) for t in tk if t.get("user_id") and m2o_id(t["user_id"]) not in (1,2)})
users = odoo_sr("res.users", [["id","in",member_ids],["active","=",True]], ["name"], 100) if member_ids else []
roster = {u["id"]: u["name"] for u in users}

# --- Tickets ouverts à risque (team Technique) ---
tickets = odoo_sr("helpdesk.ticket", [["team_id.name","=","Technique"],["stage_id.fold","=",False]],
    ["name","user_id","partner_id","stage_id","priority","date_last_stage_update","sla_fail",
     "rating_last_value","oldest_unanswered_customer_message_date","partner_open_ticket_count"], 300, "date_last_stage_update asc")

def flags(t):
    f = []
    d = days_since(t.get("date_last_stage_update"))
    if d is not None and d > STALE_DAYS: f.append(f"stale {d}j")
    if t.get("sla_fail"): f.append("SLA dépassé")
    wd = days_since(t.get("oldest_unanswered_customer_message_date"))
    if wd is not None and wd >= WAIT_DAYS: f.append(f"client en attente {wd}j")
    if not t.get("user_id"): f.append("NON ASSIGNÉ")
    if (t.get("partner_open_ticket_count") or 0) > 1: f.append(f"rebond ({t['partner_open_ticket_count']} tickets ouverts)")
    rv = t.get("rating_last_value") or 0
    if rv in (1.0, 2.0): f.append(f"client mécontent ({int(rv)}★)")
    return f

try: seen = json.load(open(STATE))
except Exception: seen = {}
now = time.time()

at_risk = []
for t in tickets:
    fl = flags(t)
    if not fl: continue
    tid = str(t["id"])
    new = (tid not in seen) or (now - seen.get(tid, 0) > RENUDGE_DAYS*86400)
    if new: seen[tid] = now
    at_risk.append((t, fl, new))
json.dump(seen, open(STATE, "w"))

# priorité : SLA + attente + stale + non-assigné d'abord, puis cap
def _score(item):
    t,fl,new=item; sc=0
    for x in fl:
        if 'SLA' in x: sc+=3
        if 'attente' in x: sc+=3
        if 'stale' in x: sc+=2
        if 'NON ASSIGN' in x: sc+=2
        if 'rebond' in x: sc+=2
        if 'mécontent' in x: sc+=3
    return sc
at_risk.sort(key=_score, reverse=True)
_total=len(at_risk)
CAP=int(os.environ.get("AIBOX_TECH_CAP","8"))
at_risk=at_risk[:CAP]

if not at_risk:
    sys.exit(0)

# --- Sortie ---
print(f"SUPERVISION TECHNIQUE — {datetime.now().strftime('%d/%m %H:%M')}")
print(f"Équipe suivie : {', '.join(roster.values()) or '(roster vide — peupler l’équipe Technique Odoo)'}")
print(f"{_total} ticket(s) à risque sur {len(tickets)} ouverts (top {len(at_risk)} traités ce passage). Applique le skill aibox-responsable-technique.\n")
# grouper par assigné
from collections import defaultdict
groups = defaultdict(list)
for t, fl, new in at_risk:
    groups[m2o(t.get("user_id")) or "NON ASSIGNÉ"].append((t, fl, new))
for who, items in sorted(groups.items(), key=lambda kv: (kv[0]=="NON ASSIGNÉ" and "0" or kv[0])):
    print(f"[{who}]")
    for t, fl, new in items:
        tag = " ⟶ ENRICHIR (nouveau)" if new else ""
        cli = m2o(t.get("partner_id")) or "?"
        print(f"  #{t['id']} « {t.get('name','')[:60]} » — client {cli} — {' ; '.join(fl)}{tag}")
    print()
