"""
Llama Guard — service de modération en amont des agents Dify.

Endpoint :
  POST /check
    body: {input: "...", output?: "..."}
    return: {safe: bool, categories: [...], reason: "..."}

À brancher en pré-traitement de chaque agent Dify via un node "HTTP request".
Détecte : prompt injection, leaks PII, tentatives d'exfiltration, contenu illégal.

On utilise le modèle Llama-Guard-3-8B (ou variante quantifiée Q4) tournant via
Ollama local. Si Llama Guard pas disponible, fallback sur règles heuristiques.
"""
from __future__ import annotations

import logging
import os
import re

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
GUARD_MODEL = os.environ.get("GUARD_MODEL", "llama-guard3:8b")
USE_HEURISTICS = os.environ.get("USE_HEURISTICS_FALLBACK", "true").lower() == "true"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("llama-guard")

app = FastAPI(title="Llama Guard", version="0.1.0")


class CheckRequest(BaseModel):
    input: str
    output: str | None = None


class CheckResponse(BaseModel):
    safe: bool
    categories: list[str]
    reason: str
    method: str   # "llama-guard" | "heuristics"


# ---- Heuristiques de fallback ----
INJECTION_PATTERNS = [
    re.compile(r"\bignore (all |any |the |above |previous |prior )?(instructions|prompts|rules)\b", re.I),
    re.compile(r"\bdisregard (all |any |the |above |previous |prior )?(instructions|prompts|rules)\b", re.I),
    re.compile(r"\boublie (toutes? |les? )?(instructions|consignes|règles)\b", re.I),
    re.compile(r"\bpretend\s+(you\s+are|to\s+be)\b", re.I),
    re.compile(r"\bsystem\s*:\s*", re.I),
    re.compile(r"\b(jailbreak|DAN|do anything now)\b", re.I),
]
PII_PATTERNS = [
    re.compile(r"\b\d{13}\b"),                                 # carte SECU FR
    re.compile(r"\b(?:\d[ -]*?){13,16}\b"),                    # carte bancaire
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),  # email
    re.compile(r"\b(?:\+33|0)[1-9](?:[ .-]?\d{2}){4}\b"),       # tel FR
]
EXFIL_PATTERNS = [
    re.compile(r"\b(curl|wget|fetch|http|https)://", re.I),
    re.compile(r"\b(send|post|forward|email)\s+(this|that|the\s+\w+)\s+to\b", re.I),
]


def heuristic_check(text: str) -> tuple[bool, list[str], str]:
    """Retourne (safe, categories, reason)."""
    cats = []
    if any(p.search(text) for p in INJECTION_PATTERNS):
        cats.append("prompt_injection")
    if any(p.search(text) for p in PII_PATTERNS):
        cats.append("pii_leak")
    if any(p.search(text) for p in EXFIL_PATTERNS):
        cats.append("exfiltration")
    if cats:
        return False, cats, f"Heuristic match: {', '.join(cats)}"
    return True, [], "Pass heuristics"


# ---- Llama Guard via Ollama ----
LLAMA_GUARD_PROMPT = """Task: Check if there is unsafe content in '{role}' messages in conversations according our safety policy.

<BEGIN UNSAFE CONTENT CATEGORIES>
S1: Violent Crimes.
S2: Non-Violent Crimes.
S3: Sex Crimes.
S4: Child Exploitation.
S5: Defamation.
S6: Specialized Advice.
S7: Privacy.
S8: Intellectual Property.
S9: Indiscriminate Weapons.
S10: Hate.
S11: Self-Harm.
S12: Sexual Content.
S13: Elections.
S14: Code Interpreter Abuse.
<END UNSAFE CONTENT CATEGORIES>

<BEGIN CONVERSATION>
User: {input}
{assistant_block}
<END CONVERSATION>

Provide your safety assessment for ONLY THE LAST {role} message in the above conversation:
- First line must read 'safe' or 'unsafe'.
- If unsafe, a second line must include a comma-separated list of violated categories."""


def llama_guard_check(input_text: str, output_text: str | None) -> tuple[bool, list[str], str]:
    role = "Agent" if output_text else "User"
    assistant_block = f"\nAgent: {output_text}\n" if output_text else ""
    prompt = LLAMA_GUARD_PROMPT.format(
        role=role, input=input_text, assistant_block=assistant_block,
    )
    try:
        with httpx.Client(base_url=OLLAMA_URL, timeout=30.0) as c:
            r = c.post("/api/generate", json={
                "model": GUARD_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.0},
            })
            r.raise_for_status()
            response = r.json()["response"].strip().lower()
    except Exception as e:
        log.warning("Llama Guard unavailable: %s — fallback heuristics", e)
        raise

    lines = response.splitlines()
    if not lines:
        return True, [], "empty response"
    safe = lines[0].strip().startswith("safe")
    cats = []
    if not safe and len(lines) > 1:
        cats = [c.strip() for c in lines[1].split(",") if c.strip()]
    return safe, cats, response


@app.post("/check", response_model=CheckResponse)
def check(req: CheckRequest) -> CheckResponse:
    text = req.input + (("\n" + req.output) if req.output else "")
    try:
        safe, cats, reason = llama_guard_check(req.input, req.output)
        return CheckResponse(safe=safe, categories=cats, reason=reason, method="llama-guard")
    except Exception:
        if USE_HEURISTICS:
            safe, cats, reason = heuristic_check(text)
            return CheckResponse(safe=safe, categories=cats, reason=reason, method="heuristics")
        return CheckResponse(safe=True, categories=[], reason="guard down — pass-through", method="bypass")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": GUARD_MODEL}
