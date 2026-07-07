#!/usr/bin/env python3
"""Detecteur d'opportunites Odoo NOUVELLES (lecture seule) pour l'agent commercial.
Sortie = liste injectee dans le prompt de l'agent (cron mode defaut + skill aibox-opportunite).
Dedup via state. stdout vide si rien de neuf."""
import os, sys, json, time, subprocess
from datetime import datetime, timedelta

HOME = os.environ.get("HERMES_HOME", "/home/clikinfo/aibox/companies/demo/users/andre/hermes")
CONN = "/home/clikinfo/BoxIA/aibox-hermes/mcp-connectors"
STATE = os.path.join(HOME, "state", "opps_seen.json")
LOOKBACK_DAYS_FIRST = 2  # 1er run : ne pas dumper tout l'historique

import yaml
cfg = yaml.safe_load(open(os.path.join(HOME, "config.yaml"))) or {}
odoo = (cfg.get("mcp_servers") or {}).get("odoo")
if not odoo:
    sys.exit(0)
env = dict(os.environ); env.update({k: str(v) for k, v in (odoo.get("env") or {}).items()})

try:
    st = json.load(open(STATE))
except Exception:
    st = {}
seen = set(st.get("seen", []))
last = st.get("last_run")
if last:
    since = datetime.fromtimestamp(last) - timedelta(minutes=10)
else:
    since = datetime.now() - timedelta(days=LOOKBACK_DAYS_FIRST)
since_s = since.strftime("%Y-%m-%d %H:%M:%S")

snip = ("import json,sys\n"
        f"sys.path.insert(0,'{CONN}/odoo')\nimport server\n"
        "fn=getattr(server.odoo_search_read,'fn',server.odoo_search_read)\n"
        "res=fn(model='crm.lead',"
        f" domain=[['type','=','opportunity'],['create_date','>=','{since_s}']],"
        " fields=['name','partner_id','email_from','contact_name','expected_revenue','description','stage_id','create_date','user_id'],"
        " limit=100, order='create_date desc')\n"
        "print(json.dumps(res, default=str))\n")
try:
    out = subprocess.run([f"{CONN}/odoo/.venv/bin/python", "-c", snip], env=env,
                         capture_output=True, text=True, timeout=60)
    rows = json.loads(out.stdout.strip() or "[]")
except Exception:
    sys.exit(0)

new = [r for r in rows if r.get("id") not in seen]

# --- Filtrage metier : ne garder que les VRAIES nouvelles a traiter ---
SKIP_STAGES = {"annul", "lost", "perdu", "gagn", "won", "proposition"}
ALL_ASSIGNEES = os.environ.get("AIBOX_OPP_ALL_ASSIGNEES", "0") == "1"
MOI = ("andre", "ladurelle")
def _keep(r):
    stage = (str(r.get("stage_id") and r["stage_id"][1] or "")).lower()
    if any(k in stage for k in SKIP_STAGES): return False           # annule/perdu/gagne/proposition
    desc = (r.get("description") or "").lower()
    if "depuis le devis" in desc: return False                       # deja devisee (auto)
    if not ALL_ASSIGNEES:
        who = (str(r.get("user_id") and r["user_id"][1] or "")).lower()
        if who and not any(m in who for m in MOI): return False       # laisse les deals de l'equipe humaine
    return True
new = [r for r in new if _keep(r)]

# maj state
seen |= {r["id"] for r in rows}
st = {"last_run": time.time(), "seen": sorted(seen)[-500:]}
json.dump(st, open(STATE, "w"))

if not new:
    sys.exit(0)

def m2o(v):  # champ many2one Odoo = [id, "label"] ou False
    return v[1] if isinstance(v, list) and len(v) > 1 else ""

print(f"NOUVELLE(S) OPPORTUNITÉ(S) À TRAITER — {len(new)} (applique le skill aibox-opportunite pour chacune) :\n")
for r in new:
    desc = (r.get("description") or "").strip().replace("\n", " ")[:300]
    print(f"— Opportunité #{r['id']} « {r.get('name','')} »")
    print(f"    Client : {m2o(r.get('partner_id')) or '(prospect nouveau)'} | email : {r.get('email_from') or '?'} | contact : {r.get('contact_name') or '?'}")
    print(f"    Montant estimé : {r.get('expected_revenue') or 0}€ | stade : {m2o(r.get('stage_id'))} | commercial : {m2o(r.get('user_id')) or 'non assigné'}")
    if desc: print(f"    Description : {desc}")
    print()
