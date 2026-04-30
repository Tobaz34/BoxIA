"""Agent 1 — Triage email.

Workflow figé : classify → analyze → draft → END

Pourquoi ce découpage :
- classify : 1 seul appel LLM, 1 seule sortie structurée (categorie + priorité)
  → maximise le taux de succès Qwen2.5-7B (~78%) car la décision est isolée
- analyze : extraction (intent, summary, PII, phishing) — appel séparé
- draft : ne tourne QUE si action == REPONDRE (économie de tokens)
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph

from app.config import get_settings
from app.llm import structured_invoke, get_chat_model
from app.schemas import (
    EmailAction,
    EmailCategory,
    EmailPriority,
    GraphMetadata,
    SuggestedAction,
    TriageEmailRequest,
    TriageEmailResponse,
)

logger = logging.getLogger(__name__)


# =============================================================================
# State
# =============================================================================

class EmailState(TypedDict, total=False):
    request: TriageEmailRequest
    classification: dict      # category, priority, confidence
    analysis: dict             # intent, summary, PII, phishing
    draft: str | None
    suggested_actions: list[SuggestedAction]
    needs_human_validation: bool
    started_at: float
    steps: int


# =============================================================================
# Schemas locaux pour les sorties intermédiaires
# =============================================================================
# Volontairement strictes et minimales pour maximiser le succès JSON sur 7B.
# Avec normalize_keys + ConfigDict(extra="ignore") pour absorber les dérives.

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.utils.coercion import normalize_keys


class _Classification(BaseModel):
    model_config = ConfigDict(extra="ignore")
    category: EmailCategory
    priority: EmailPriority
    confidence: float = Field(..., ge=0.0, le=1.0)

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


class _Analysis(BaseModel):
    model_config = ConfigDict(extra="ignore")
    intent: str = Field("", description="Besoin émetteur en 1 phrase")
    summary: str = Field("", description="Synthèse en 2-3 phrases")
    contains_pii: bool = False
    contains_phishing_signals: bool = False
    # Default ARCHIVER si LLM oublie : safe (pas d'action côté monde réel) →
    # le humain validera en aval.
    suggested_action: EmailAction = EmailAction.ARCHIVER
    rationale: str = Field("", description="Pourquoi cette action, en 1 phrase")

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


# =============================================================================
# Nœuds
# =============================================================================

async def classify_node(state: EmailState) -> EmailState:
    """Classification catégorie + priorité — 1 appel LLM, 1 schema strict."""
    req = state["request"]

    system = SystemMessage(content=(
        "Tu es un assistant expert en tri d'emails professionnels français. "
        "Classe l'email selon la catégorie ET la priorité. "
        "Réponds UNIQUEMENT avec un JSON conforme au schéma demandé. "
        "Pas de texte avant ou après le JSON."
    ))

    user_content = (
        f"Email à classer :\n"
        f"De : {req.sender_name or req.sender} <{req.sender}>\n"
        f"Sujet : {req.subject}\n"
        f"Reçu le : {req.received_at.isoformat()}\n"
        f"Pièces jointes : {'oui' if req.has_attachments else 'non'}\n\n"
        f"Corps :\n{req.body[:4000]}\n\n"
        "Catégories possibles : commercial, support, administratif, "
        "interne, spam, newsletter, autre.\n"
        "Priorités possibles : urgent, haute, normale, basse, info.\n"
        "Confidence entre 0.0 et 1.0."
    )

    result = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _Classification,
        temperature=0.1,
    )

    state["classification"] = result.model_dump()
    state["steps"] = state.get("steps", 0) + 1
    return state


async def analyze_node(state: EmailState) -> EmailState:
    """Extraction intent / summary / PII / phishing / action recommandée."""
    req = state["request"]
    cls = state["classification"]

    system = SystemMessage(content=(
        "Tu es un assistant analyste d'emails professionnels français. "
        "Extrait l'intention, résume le contenu, et recommande UNE action. "
        "Réponds UNIQUEMENT avec un objet JSON plat (PAS de wrapper), "
        "TOUS les champs ci-dessous OBLIGATOIRES :\n"
        '{\n'
        '  "intent": "Phrase décrivant le besoin émetteur",\n'
        '  "summary": "Synthèse en 2-3 phrases",\n'
        '  "contains_pii": false,\n'
        '  "contains_phishing_signals": false,\n'
        '  "suggested_action": "repondre",\n'
        '  "rationale": "Une phrase expliquant le choix d\'action"\n'
        '}\n'
        "Le champ suggested_action DOIT être l'une des valeurs exactes : "
        "repondre, transferer, archiver, supprimer, creer_ticket, "
        "planifier_rdv, devis_a_generer."
    ))

    history = ""
    if req.thread_history:
        history = "\nContexte (messages précédents du fil) :\n"
        for h in req.thread_history[-3:]:
            history += f"- {h[:200]}\n"

    user_content = (
        f"Email (catégorie={cls['category']}, priorité={cls['priority']}) :\n"
        f"De : {req.sender_name or req.sender}\n"
        f"Sujet : {req.subject}\n"
        f"Corps :\n{req.body[:4000]}\n"
        f"{history}\n"
        "PII = données personnelles RGPD (NIR, IBAN, RIB, numéro CNI, etc.).\n"
        "Phishing = signaux suspects (URL douteuse, urgence, demande credentials).\n\n"
        "Génère le JSON complet avec les 6 champs."
    )

    result = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _Analysis,
        temperature=0.2,
    )

    state["analysis"] = result.model_dump()
    state["suggested_actions"] = [
        SuggestedAction(
            action=result.suggested_action,
            rationale=result.rationale,
            target=req.sender if result.suggested_action == EmailAction.REPONDRE else None,
        )
    ]

    # Validation humaine si confidence basse, action sensible, ou phishing détecté
    cls_conf = cls["confidence"]
    sensitive_action = result.suggested_action in {
        EmailAction.SUPPRIMER, EmailAction.DEVIS_A_GENERER,
    }
    state["needs_human_validation"] = (
        cls_conf < 0.7
        or result.contains_phishing_signals
        or sensitive_action
    )
    state["steps"] = state.get("steps", 0) + 1
    return state


async def draft_node(state: EmailState) -> EmailState:
    """Brouillon de réponse — uniquement si action == REPONDRE."""
    actions = state.get("suggested_actions", [])
    if not actions or actions[0].action != EmailAction.REPONDRE:
        state["draft"] = None
        return state

    req = state["request"]
    analysis = state["analysis"]

    system = SystemMessage(content=(
        "Tu es un assistant de rédaction d'emails professionnels français. "
        "Rédige un brouillon de réponse courtois, concis, et adapté au ton "
        "de l'email reçu. N'invente pas d'engagement ferme (livraison, prix, "
        "rendez-vous précis) — utilise des formulations conditionnelles. "
        "N'inclus ni objet, ni signature : juste le corps du message en français."
    ))

    user_content = (
        f"Email reçu de {req.sender_name or req.sender} :\n"
        f"Sujet : {req.subject}\n\n{req.body[:3000]}\n\n"
        f"Intention détectée : {analysis['intent']}\n"
        f"Synthèse : {analysis['summary']}\n\n"
        "Rédige le brouillon de réponse :"
    )

    llm = get_chat_model(temperature=0.4)
    response = await llm.ainvoke([system, HumanMessage(content=user_content)])
    content = response.content if isinstance(response.content, str) else str(response.content)

    state["draft"] = content.strip()
    state["steps"] = state.get("steps", 0) + 1
    return state


# =============================================================================
# Graph builder
# =============================================================================

def build_email_triage_graph():
    """Construit et compile le graphe LangGraph (avec checkpointer si dispo)."""
    from app.persistence import get_checkpointer

    graph = StateGraph(EmailState)
    graph.add_node("classify", classify_node)
    graph.add_node("analyze", analyze_node)
    graph.add_node("draft", draft_node)

    graph.set_entry_point("classify")
    graph.add_edge("classify", "analyze")
    graph.add_edge("analyze", "draft")
    graph.add_edge("draft", END)

    return graph.compile(checkpointer=get_checkpointer())


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_email_triage_graph()
    return _GRAPH


# =============================================================================
# Entry point (appelé par FastAPI)
# =============================================================================

async def run(request: TriageEmailRequest, thread_id: str | None = None) -> TriageEmailResponse:
    s = get_settings()
    started = time.time()

    initial_state: EmailState = {
        "request": request,
        "started_at": started,
        "steps": 0,
    }

    # Le checkpointer LangGraph exige toujours un thread_id (sinon ValueError).
    # Si le caller n'en fournit pas, on en génère un éphémère par run.
    import uuid
    effective_thread_id = thread_id or f"ephemeral-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": effective_thread_id}}
    result_state = await get_graph().ainvoke(initial_state, config=config)

    duration_ms = int((time.time() - started) * 1000)
    cls = result_state["classification"]
    analysis = result_state["analysis"]

    return TriageEmailResponse(
        category=cls["category"],
        priority=cls["priority"],
        confidence=cls["confidence"],
        intent=analysis["intent"],
        summary=analysis["summary"],
        contains_pii=analysis["contains_pii"],
        contains_phishing_signals=analysis["contains_phishing_signals"],
        suggested_reply=result_state.get("draft"),
        suggested_actions=result_state.get("suggested_actions", []),
        needs_human_validation=result_state.get("needs_human_validation", False),
        metadata=GraphMetadata(
            graph_name="email_triage",
            steps_executed=result_state.get("steps", 0),
            duration_ms=duration_ms,
            model_used=s.llm_main,
            backend=s.inference_backend,
        ),
    )
