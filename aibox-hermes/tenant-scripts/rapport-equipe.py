#!/usr/bin/env python3
"""Rapport d'equipe INCREMENTAL pour le patron, livre sur Telegram.
Chaque run couvre l'activite DEPUIS LE DERNIER rapport (fenetre glissante),
pour ne pas relire 5x la meme chose. stdout vide => cron silencieux."""
import json, os, time, re
from datetime import datetime

HOME = os.environ.get("HERMES_HOME", "/home/clikinfo/aibox/companies/demo/users/andre/hermes")
BASE = "/home/clikinfo/aibox/companies/demo/agents"
STATE = os.path.join(HOME, "state", "rapport_last.txt")
AGENTS = [("Assistante","assistante"),("Commercial","commercial"),("Technique","technique"),
          ("Comptabilite","comptabilite"),("Direction","direction")]

NOW = time.time()
lt = time.localtime(NOW)
midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0,0,0,0,0,-1))
try:
    T0 = float(open(STATE).read().strip())
    if T0 > NOW or T0 < midnight - 3*86400:  # borne de securite
        T0 = midnight
except Exception:
    T0 = midnight

def load(name):
    f = f"{BASE}/{name}/hermes/.aibox-audit.jsonl"; rows=[]
    try:
        for l in open(f, encoding="utf-8"):
            try: d=json.loads(l)
            except: continue
            if T0 <= d.get("ts",0) < NOW: rows.append(d)
    except FileNotFoundError: pass
    return rows

def arg(d,*keys):
    raw=d.get("args","") or ""
    try:
        a=json.loads(raw)
        for k in keys:
            if a.get(k): return a.get(k)
    except Exception: pass
    for k in keys:
        m=re.search(r'"'+re.escape(k)+r'"\s*:\s*"([^"]*)"', raw)
        if m: return m.group(1)
    return None

def summarize(rows):
    if not rows: return None
    tri=sum(1 for r in rows if any(x in r["tool"] for x in ("list_recent_emails","read_email","mark_email_read","list_mail_folders")))
    acts=[]
    leads=[x for x in (arg(r,"name") for r in rows if "create_lead" in r["tool"] and not r.get("error")) if x]
    drafts=sum(1 for r in rows if "create_draft_email" in r["tool"] and not r.get("error"))
    sends =sum(1 for r in rows if any(x in r["tool"] for x in ("send_draft_email","send_email","reply_to_email")) and not r.get("error"))
    notes =sum(1 for r in rows if "log_note" in r["tool"] and not r.get("error"))
    tickets=sum(1 for r in rows if "create_ticket" in r["tool"] and not r.get("error"))
    if tri: acts.append(f"trie {tri} emails")
    for nm in leads[:3]: acts.append(f"cree le lead « {nm[:60]} »")
    if drafts: acts.append(f"prepare {drafts} brouillon(s)")
    if sends:  acts.append(f"envoye {sends} email(s)")
    if notes:  acts.append(f"{notes} note(s) CRM/ticket")
    if tickets:acts.append(f"ouvert {tickets} ticket(s)")
    return acts or None

lines=[]
for label,name in AGENTS:
    acts=summarize(load(name))
    if acts: lines.append(f"• [{label}] Patron : " + " ; ".join(acts) + ".")
drows=load("dispatcher")
mv=sum(1 for r in drows if "move_email" in r["tool"] and not r.get("error"))
if mv: lines.append(f"• [Tri] Patron : j'ai routé {mv} emails vers les bonnes équipes.")

# avance la fenetre quoi qu'il arrive
try:
    open(STATE,"w").write(str(NOW))
except Exception: pass

if not lines:
    raise SystemExit(0)

dn=datetime.fromtimestamp(NOW)
h0=datetime.fromtimestamp(T0)
entete=f"🧑‍💼 Rapport d'équipe — {dn.hour:02d}h (depuis {h0.hour:02d}h{h0.minute:02d})"
print("\n".join([entete,""]+lines))
