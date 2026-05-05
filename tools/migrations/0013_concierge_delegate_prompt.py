"""Migration 0013 — injecte un bloc [DELEGATE-V1] dans le pre_prompt
du Concierge BoxIA pour activer le tool `delegate_to_specialist`.

Contexte : P0 #4 du plan v2 OSS-inspired
(cf tools/research/audit_P0_04_delegate.md + DECISIONS-P0.md §D5).

Avant : nos 6 agents Dify sont isolés. Le Concierge ne peut pas exploiter
les compétences du specialist comptable / juridique / vision sans demander
à l'user de changer manuellement d'agent.

Cette migration :
1. Injecte un bloc [DELEGATE-V1] en tête du pre_prompt Concierge avec :
   - QUAND déléguer (questions hors-scope du Concierge)
   - À QUI (slugs autorisés : general, vision, accountant, hr, support)
   - COMMENT (format prompt enrichi avec contexte)
   - COMMENT EXPLOITER la réponse (synthétiser, pas copier)
   - QUAND NE PAS DÉLÉGUER (questions sur l'admin de la box)

2. Idempotente : marqueur `[DELEGATE-V1]` en tête → re-run = no-op.

Note importante : cette migration NE FAIT PAS la registration du tool
côté provider Custom Tool Dify. Elle suppose que le tool est déjà
enregistré côté Dify (à faire dans une migration suivante 0014 avec
le YAML OpenAPI delegate-to-specialist-openapi.yaml). Sans la
registration, le LLM connaîtra le tool dans son prompt mais ne pourra
pas l'appeler concrètement.

Auth Dify : cookies + X-CSRF-TOKEN, pattern partagé avec 0010/0011/0012.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DESCRIPTION = "Injecte instructions [DELEGATE-V1] dans le pre_prompt du Concierge BoxIA"

DIFY_API_URL = os.environ.get("DIFY_CONSOLE_API", "http://localhost:8081/console/api")
DIFY_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
DIFY_ADMIN_PASSWORD = os.environ.get("DIFY_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", "")

# Cible : uniquement le Concierge. On pourrait étendre à l'Assistant général
# plus tard si on observe que les délégations fonctionnent bien.
TARGET_AGENT_NAMES = [
    "Concierge BoxIA",
]

MARKER = "[DELEGATE-V1]"

DELEGATE_BLOCK = """[DELEGATE-V1]
═══════════════════════════════════════════════════════════════════════
DÉLÉGATION À UN SPECIALIST — Tool delegate_to_specialist
═══════════════════════════════════════════════════════════════════════

Tu as accès à un outil `delegate_to_specialist` qui te permet de poser
une question à un autre agent spécialisé et d'intégrer sa réponse dans
ton raisonnement avant de répondre à l'user.

QUAND DÉLÉGUER :
- L'user pose une question qui dépasse ton scope (configuration BoxIA)
- Tu as besoin d'une expertise pointue : analyse d'image, comptabilité
  française, droit du travail, ton commercial professionnel
- L'user demande une analyse hybride (ex: "regarde cette facture jointe
  et confirme le taux TVA pour 2026") qui mélange plusieurs domaines

À QUI DÉLÉGUER (slugs disponibles) :
- `general`     → questions générales, résumé de docs texte, rédaction
- `vision`      → analyse d'images, captures, schémas, OCR
- `accountant`  → TVA, devis, factures, comptabilité française
- `hr`          → congés, contrats, droit du travail français
- `support`     → réponses commerciales, ton client professionnel

⚠️ INTERDIT : déléguer à `concierge` (toi-même) — pas de récursion.

COMMENT APPELER :
```
delegate_to_specialist(
  slug="accountant",
  prompt="Question enrichie avec contexte. Mentionne le specialist :
         'Tu es l'agent comptable. L'user demande X. Réponds en privilégiant
         les normes FR 2026.'"
)
```

Le param `prompt` doit être SELF-CONTAINED — le specialist n'a PAS le
contexte conversationnel de l'user. Inclus :
1. Le rôle du specialist (« Tu es l'agent comptable »)
2. La question utilisateur reformulée
3. Les contraintes ou contexte pertinents

COMMENT EXPLOITER LA RÉPONSE :
- Le tool renvoie `{ok: true, answer: "...", agent: {slug, name, icon}}`
- Synthétise `answer` dans ta propre réponse à l'user — ne copie-colle
  PAS littéralement.
- Mentionne brièvement la délégation : « J'ai consulté l'Assistant comptable :
  [synthèse]. Pour aller plus loin, ouvre la conversation [Assistant comptable]. »
- Si l'answer contient `requires_approval=true`, propage l'info à l'user.
- Si le tool retourne ok=false (timeout, agent indisponible) : explique-le
  honnêtement à l'user et propose une alternative.

FORMAT DE TRACE UI (OBLIGATOIRE pour la transparence) :
Quand tu utilises la réponse d'une délégation dans ton message à l'user,
ENTOURE la réponse intégrée d'un marker spécial qui sera rendu en bloc
collapsible 🤝 dans le chat :

  [DELEGATION:<slug>:<depth>:<status>]
  <réponse brute du specialist, ou court résumé si trop long>
  [/DELEGATION]

Exemples :
  [DELEGATION:accountant:1:success]
  Le taux de TVA pour la livraison de repas à domicile en France est
  de 10 % en 2026 (BOFIP-IT-DEFINITION-CGI-art-279)…
  [/DELEGATION]

  [DELEGATION:vision:1:success]
  L'image montre une facture Pinacle datée du 15/03/2025, montant TTC 1234€
  …
  [/DELEGATION]

  [DELEGATION:hr:1:failed]
  L'agent RH n'a pas pu répondre (timeout 60s).
  [/DELEGATION]

Le marker est CACHÉ dans le rendu UI (transformé en bloc collapsible).
PUIS tu écris ta synthèse APRÈS le marker. L'user voit les deux : le
marker (replié par défaut) et ta synthèse (toujours visible). C'est la
transparence RGPD : « voici ce qu'on m'a dit, voici comment je
l'interprète ».

QUAND NE PAS DÉLÉGUER :
- Questions admin BoxIA (connecteurs, workflows, marketplace, MCP) → tu réponds
- Questions simples (heure, météo, calcul rapide) → tu réponds
- Profondeur de délégation > 1 (tu es déjà délégué) → réponds directement

GARDE-FOUS TECHNIQUES (auto-appliqués par le tool) :
- Profondeur max = 2 (tu peux déléguer 1 fois ; le specialist ne peut PAS
  re-déléguer)
- Timeout 60s par délégation
- Refus self-delegation au concierge

═══════════════════════════════════════════════════════════════════════

"""


# ---------------------------------------------------------------------------
# Auth Dify (cookies + CSRF) — pattern partagé avec 0010/0011/0012
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


def _inject_delegate_block(s, app_name: str) -> dict:
    app = _find_app(s, app_name)
    if not app:
        return {"app": app_name, "status": "not_found"}
    cfg_full = s.get(f"/apps/{app['id']}")
    model_config = cfg_full.get("model_config") or {}

    pre_prompt = model_config.get("pre_prompt") or ""
    if MARKER in pre_prompt:
        return {"app": app_name, "status": "already_applied"}

    new_pre_prompt = DELEGATE_BLOCK + pre_prompt
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
    # Applied = au moins 1 agent cible a déjà le marker
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
            r = _inject_delegate_block(s, name)
            results.append(r)
            print(f"  - {r}")
        except Exception as e:
            results.append({"app": name, "status": "error", "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)
    injected = sum(1 for r in results if r.get("status") == "injected")
    print(f"  ✓ Injection DELEGATE block — {injected}/{len(TARGET_AGENT_NAMES)} agents modifiés")
    print()
    print("⚠️  RAPPEL : cette migration injecte le pre_prompt seulement.")
    print("   Pour que le Concierge puisse APPELER le tool, il faut aussi :")
    print("   1. Enregistrer le Custom Tool dans Dify avec l'OpenAPI YAML")
    print("      (migration 0014 à venir, ou registration manuelle via console)")
    print("   2. Vérifier que le service aibox-app expose")
    print("      POST /api/agents-tools/delegate_to_specialist (déjà fait dans le code)")


if __name__ == "__main__":
    if is_applied():
        print("Déjà appliquée")
        sys.exit(0)
    run()
