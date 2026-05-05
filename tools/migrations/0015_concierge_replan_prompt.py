"""Migration 0015 — injecte un bloc [REPLAN-V1] dans le pre_prompt
du Concierge BoxIA pour activer la replanification dynamique sur
tool-fail + le pre-routing complexity HIGH/LOW.

Référence : tools/research/audit_P0_05_replan.md +
            DECISIONS-P0.md §D4 (Option A prompt-only).

Contexte : nos tools agents-tools renvoient depuis Sprint 0 S0.2 un
contrat unifié `{ok:false, error, hint, retryable, retry_after_ms?}`.
Le Concierge en mode function_call (migration 0012) reçoit ces erreurs
mais ne sait pas quoi en faire — il abandonne ou répète bêtement.

Cette migration ajoute des règles explicites dans le pre_prompt :
1. Comment exposer un PLAN avant exécution si tâche multi-step
2. Comment réagir sur tool-fail :
   - retryable=true → retry une fois (max 1) puis adapter le plan
   - retryable=false → réécrire le plan ou abandonner avec explication
3. Pre-routing HIGH/LOW : si la tâche est triviale, NE PAS générer de plan

Idempotente : marqueur `[REPLAN-V1]` → re-run = no-op.

V2 envisagé si le taux de succès reste <70% sur les tâches multi-step
mesuré via Langfuse spans (S0.3) après 1 semaine de prod : passer à un
wrapper Next.js SSE qui intercepte les tool-fails et ré-injecte le plan
côté serveur (audit P0 #5 Option B).

Auth Dify : cookies + X-CSRF-TOKEN, pattern hérité de 0010/0011/0013.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DESCRIPTION = "Injecte instructions [REPLAN-V1] dans le pre_prompt du Concierge BoxIA"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")

TARGET_AGENT_NAMES = [
    "Concierge BoxIA",
]

MARKER = "[REPLAN-V1]"

REPLAN_BLOCK = """[REPLAN-V1]
═══════════════════════════════════════════════════════════════════════
PLANIFICATION & RÉSILIENCE — Replan dynamique sur tool-fail
═══════════════════════════════════════════════════════════════════════

PRE-ROUTING COMPLEXITY (avant de répondre, classifie la requête) :
- LOW : questions simples (« quelle heure », « bonjour », « capitale FR »,
  « explique-moi X », « résume ce document ») — réponds DIRECTEMENT, pas
  de plan, pas de tool si pas nécessaire.
- HIGH : tâches multi-step avec verbes chaînés (« puis », « et après »,
  « ensuite »), plusieurs connecteurs (Pennylane + Gmail + Calendar),
  actions mutatives (envoi mail, install workflow), conditions
  (« si X alors Y ») → ACTIVE le mode plan-replan ci-dessous.

MODE PLAN-REPLAN (si HIGH) :

1. AVANT d'exécuter, EXPOSE ton plan en 1-3 phrases courtes :
   « Plan : 1) cherche facture X dans Pennylane (pennylane_search)
            2) télécharge le PDF (pennylane_get_pdf)
            3) compose un email à Y (concierge → user valide envoi) »
   L'user voit le plan AVANT que tu exécutes — il peut interrompre.

2. EXÉCUTE step-by-step. Après CHAQUE tool-call, vérifie le résultat :

   ┌─ Format des erreurs tools (Sprint 0 S0.2) ──────────────────────┐
   │ {                                                                │
   │   "ok": false,                                                   │
   │   "error": "<code>",        ← code court machine                 │
   │   "hint": "<message FR>",   ← explication pour toi               │
   │   "retryable": true|false,  ← clé de décision                    │
   │   "retry_after_ms": 5000    ← présent si retryable=true          │
   │ }                                                                │
   └──────────────────────────────────────────────────────────────────┘

3. DÉCISION sur tool-fail :

   - retryable=true → re-essaie MAX 1 FOIS (attends retry_after_ms si
     fourni). Si re-fail → traite comme retryable=false.
   - retryable=false (validation, auth, config) → NE PAS retry. Tu as 2 options :
     a) RÉÉCRIS le plan : adapte avec un autre tool ou une autre approche.
        Ex : pennylane down → tente la recherche dans rag_search avec
        des mots-clés équivalents.
     b) ABANDONNE proprement : explique à l'user que cette étape n'est
        pas réalisable (avec le hint reçu), propose une alternative manuelle.

   - tool sensitive_action sans approval → c'est NORMAL au 1er appel.
     Le retour {requires_approval, action_id} signifie « le user va voir
     le banner et valider ». Indique-le à l'user et continue les autres
     steps non-bloquants en attendant. NE PAS retry.

4. SUR APPROVAL_REJECTED → passe au plan B. Ne ré-essaie pas la même
   action. Si pas de plan B → explique à l'user.

QUAND NE PAS PLANIFIER (force LOW) :
- L'user pose une question factuelle ou demande une explication
- Pas de verbe d'action (« qu'est-ce que », « comment fonctionne »,
  « explique »)
- Pas de mention d'un connecteur
- Salutation, courtoisie

ÉCONOMIE TOKENS : un plan inutile sur question LOW gaspille 200-400 tokens.
Un plan absent sur tâche HIGH multi-step te fait planter au premier fail.
La distinction est cruciale pour la fluidité UX.

═══════════════════════════════════════════════════════════════════════

"""


# ---------------------------------------------------------------------------
# Auth Dify (cookies + CSRF) — pattern partagé avec 0010/0011/0013
# ---------------------------------------------------------------------------

class _DifySession:
    def __init__(self, base):
        self.base = base
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj),
        )
        self.access_token = None
        self.csrf_token = None

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        if self.csrf_token:
            h["X-CSRF-TOKEN"] = self.csrf_token
        if extra:
            h.update(extra)
        return h

    def login(self, email, password):
        if not email or not password:
            raise RuntimeError("ADMIN_EMAIL ou ADMIN_PASSWORD manquant")
        body = json.dumps({
            "email": email, "password": password,
            "language": "fr-FR", "remember_me": True,
        }).encode()
        req = urllib.request.Request(
            f"{self.base}/login",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with self.opener.open(req, timeout=15) as r:
            r.read()
        for c in self.cj:
            if c.name == "access_token":
                self.access_token = c.value
            elif c.name == "csrf_token":
                self.csrf_token = c.value
        if not self.access_token:
            raise RuntimeError("Login Dify : pas d'access_token")

    def get(self, path):
        req = urllib.request.Request(
            f"{self.base}{path}",
            headers=self._headers(),
            method="GET",
        )
        with self.opener.open(req, timeout=20) as r:
            return json.loads(r.read())

    def post(self, path, body):
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode(),
            headers=self._headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with self.opener.open(req, timeout=30) as r:
            raw = r.read()
            try:
                return json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return {"raw": raw.decode("utf-8", errors="replace")}


def _connect():
    s = _DifySession(DIFY_API_URL)
    s.login(DIFY_ADMIN_EMAIL, DIFY_ADMIN_PASSWORD)
    return s


def _find_app(s, name):
    try:
        r = s.get("/apps?page=1&limit=100")
        for a in r.get("data") or []:
            if a.get("name") == name:
                return a
    except Exception:
        pass
    return None


def _inject_replan_block(s, app_name: str) -> dict:
    app = _find_app(s, app_name)
    if not app:
        return {"app": app_name, "status": "not_found"}
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}

    pre_prompt = model_config.get("pre_prompt") or ""
    if MARKER in pre_prompt:
        return {"app": app_name, "status": "already_applied"}

    new_pre_prompt = REPLAN_BLOCK + pre_prompt
    model_config["pre_prompt"] = new_pre_prompt

    # Strip read-only fields (Dify ≥1.10)
    for k in ("id", "app_id", "provider", "created_at", "updated_at"):
        model_config.pop(k, None)

    s.post(f"/apps/{app['id']}/model-config", model_config)
    return {
        "app": app_name,
        "status": "injected",
        "before_chars": len(pre_prompt),
        "after_chars": len(new_pre_prompt),
    }


def is_applied() -> bool:
    try:
        s = _connect()
    except Exception as e:
        print(f"  is_applied: login Dify impossible ({e})", file=sys.stderr)
        return False
    for name in TARGET_AGENT_NAMES:
        app = _find_app(s, name)
        if not app:
            continue
        cfg = s.get(f"/apps/{app['id']}")
        pp = (cfg.get("model_config") or {}).get("pre_prompt") or ""
        if MARKER not in pp:
            return False
    return True


def run() -> None:
    s = _connect()
    results = []
    for name in TARGET_AGENT_NAMES:
        try:
            r = _inject_replan_block(s, name)
            results.append(r)
            print(f"  - {r}")
        except Exception as e:
            results.append({"app": name, "status": "error", "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)
    injected = sum(1 for r in results if r.get("status") == "injected")
    print(f"  ✓ Injection REPLAN block — {injected}/{len(TARGET_AGENT_NAMES)} agents modifiés")
    print()
    print("⚠️  RAPPEL : mesurer via Langfuse spans (Sprint 0 S0.3) le taux de")
    print("   succès des tâches multi-step après 1 semaine. Si <70% → escalade")
    print("   vers Option B wrapper Next.js (audit P0 #5).")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
