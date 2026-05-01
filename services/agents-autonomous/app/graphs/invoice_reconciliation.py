"""Agent 3 — Rapprochement facture (fournisseur ou client).

Workflow figé : extract → match → assess → END

- extract : OCR/texte → InvoiceData structurée (n°, date, montants, vendor)
- match : compare avec candidats fournis (BDC, paiements) — algo déterministe
  pour le scoring + LLM pour l'analyse des divergences textuelles
- assess : décision finale (valider / enquêter / rejeter) + recommandation

Le matching de base est DÉTERMINISTE (Python pur) — on n'utilise le LLM que
pour l'extraction et la formulation de la recommandation, pas pour calculer
des scores numériques (les LLM 7B sont mauvais pour ça).
"""
from __future__ import annotations

import logging
import time
from datetime import date
from decimal import Decimal
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import get_settings
from app.llm import structured_invoke
from app.schemas import (
    CandidateMatch,
    GraphMetadata,
    InvoiceData,
    MatchStatus,
    ReconcileInvoiceRequest,
    ReconcileInvoiceResponse,
)
from app.utils.coercion import normalize_keys

logger = logging.getLogger(__name__)

# Seuils de matching (configurables plus tard via env)
EXACT_AMOUNT_TOLERANCE_EUR = Decimal("0.01")    # centime près
PARTIAL_AMOUNT_TOLERANCE_PCT = Decimal("2.0")    # 2% d'écart toléré
EXACT_DATE_TOLERANCE_DAYS = 0
PARTIAL_DATE_TOLERANCE_DAYS = 30


# =============================================================================
# State
# =============================================================================

class InvoiceState(TypedDict, total=False):
    request: ReconcileInvoiceRequest
    invoice_data: InvoiceData
    scored_candidates: list[CandidateMatch]
    best_match: CandidateMatch | None
    match_status: MatchStatus
    discrepancies: list[str]
    assessment: dict
    started_at: float
    steps: int


# =============================================================================
# Schemas locaux
# =============================================================================

class _ExtractedInvoice(BaseModel):
    model_config = ConfigDict(extra="ignore")
    invoice_number: str
    invoice_date: str = Field(..., description="Format ISO YYYY-MM-DD")
    due_date: str | None = Field(None, description="Format ISO YYYY-MM-DD, ou null")
    vendor_name: str | None = None
    vendor_siret: str | None = Field(None, pattern=r"^[0-9]{14}$|^$")
    customer_name: str | None = None
    total_ht_eur: float | None = Field(None, ge=0)
    total_ttc_eur: float = Field(..., ge=0)
    vat_eur: float | None = Field(None, ge=0)
    reference: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


class _Assessment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    recommended_action: str = Field(
        ...,
        description="valider | enquêter | rejeter | demander_info",
    )
    explanation: str = Field(..., description="Raisonnement en 2-3 phrases en français")
    needs_human_validation: bool = False

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


# =============================================================================
# Nœuds
# =============================================================================

async def extract_node(state: InvoiceState) -> InvoiceState:
    """Extraction structurée depuis le texte de la facture (OCR)."""
    req = state["request"]

    if req.invoice_data:
        # Court-circuit : caller a déjà extrait
        state["invoice_data"] = req.invoice_data
        state["steps"] = state.get("steps", 0) + 1
        return state

    system = SystemMessage(content=(
        "Tu es un assistant de comptabilité française. Extrais les données "
        "structurées d'une facture depuis son texte (OCR ou copier-coller). "
        "Si une donnée n'est pas présente ou ambiguë, mets null. "
        "Les montants sont en euros, point décimal. "
        "Les dates au format ISO YYYY-MM-DD. "
        "Réponds UNIQUEMENT avec un JSON conforme au schéma."
    ))

    user_content = (
        f"Type : facture {req.invoice_type.value}\n\n"
        f"Texte de la facture :\n{req.invoice_text[:8000]}\n\n"
        "Extrais les champs."
    )

    extracted = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _ExtractedInvoice,
        temperature=0.1,
    )

    invoice_data = InvoiceData(
        invoice_number=extracted.invoice_number,
        invoice_date=date.fromisoformat(extracted.invoice_date),
        due_date=date.fromisoformat(extracted.due_date) if extracted.due_date else None,
        vendor_name=extracted.vendor_name,
        vendor_siret=extracted.vendor_siret or None,
        customer_name=extracted.customer_name,
        total_ht_eur=Decimal(str(extracted.total_ht_eur)) if extracted.total_ht_eur else None,
        total_ttc_eur=Decimal(str(extracted.total_ttc_eur)),
        vat_eur=Decimal(str(extracted.vat_eur)) if extracted.vat_eur else None,
        reference=extracted.reference,
    )
    state["invoice_data"] = invoice_data
    state["steps"] = state.get("steps", 0) + 1
    return state


def _score_candidate(invoice: InvoiceData, candidate: CandidateMatch) -> CandidateMatch:
    """Calcule le score de matching entre facture et candidat (algo déterministe).

    Composantes :
    - Référence textuelle (poids 0.4 si match)
    - Écart montant (poids 0.4 décroissant linéairement)
    - Écart date (poids 0.2 décroissant linéairement)
    """
    score = 0.0

    # 1. Référence
    if invoice.reference and candidate.reference:
        if invoice.reference.strip().lower() == candidate.reference.strip().lower():
            score += 0.4
        elif (invoice.reference.lower() in candidate.reference.lower()
              or candidate.reference.lower() in invoice.reference.lower()):
            score += 0.2

    # 2. Montant
    delta_amount = abs(invoice.total_ttc_eur - candidate.amount_eur)
    if delta_amount <= EXACT_AMOUNT_TOLERANCE_EUR:
        score += 0.4
    else:
        # Pourcentage d'écart
        pct = (delta_amount / invoice.total_ttc_eur) * Decimal("100") if invoice.total_ttc_eur else Decimal("100")
        if pct <= PARTIAL_AMOUNT_TOLERANCE_PCT:
            # Décroissance linéaire de 0.4 (à 0%) vers 0.2 (à 2%)
            score += float(Decimal("0.4") - (pct / PARTIAL_AMOUNT_TOLERANCE_PCT) * Decimal("0.2"))
        elif pct <= Decimal("10.0"):
            score += 0.05

    # 3. Date
    delta_days = abs((invoice.invoice_date - candidate.date).days)
    if delta_days == 0:
        score += 0.2
    elif delta_days <= 7:
        score += 0.15
    elif delta_days <= PARTIAL_DATE_TOLERANCE_DAYS:
        score += 0.05

    score = max(0.0, min(1.0, score))

    return candidate.model_copy(update={
        "score": round(score, 3),
        "delta_eur": delta_amount.quantize(Decimal("0.01")),
        "delta_days": delta_days,
    })


async def match_node(state: InvoiceState) -> InvoiceState:
    """Scoring déterministe de chaque candidat (Python pur, pas de LLM)."""
    req = state["request"]
    invoice = state["invoice_data"]

    if not req.candidates:
        state["scored_candidates"] = []
        state["best_match"] = None
        state["match_status"] = MatchStatus.INTROUVABLE
        state["discrepancies"] = ["Aucun candidat fourni pour le rapprochement"]
        state["steps"] = state.get("steps", 0) + 1
        return state

    scored = sorted(
        (_score_candidate(invoice, c) for c in req.candidates),
        key=lambda c: c.score,
        reverse=True,
    )
    best = scored[0]

    if best.score >= 0.85:
        status = MatchStatus.EXACT
    elif best.score >= 0.5:
        status = MatchStatus.PARTIEL
    elif best.score >= 0.2:
        status = MatchStatus.DIVERGENT
    else:
        status = MatchStatus.INTROUVABLE
        best = None

    discrepancies = []
    if best:
        if best.delta_eur > EXACT_AMOUNT_TOLERANCE_EUR:
            discrepancies.append(
                f"Écart de montant : {best.delta_eur} € "
                f"(facture {invoice.total_ttc_eur} € vs candidat {best.amount_eur} €)"
            )
        if best.delta_days > EXACT_DATE_TOLERANCE_DAYS:
            discrepancies.append(
                f"Écart de date : {best.delta_days} jour(s) "
                f"(facture {invoice.invoice_date} vs candidat {best.date})"
            )
        if not invoice.reference and not best.reference:
            discrepancies.append("Aucune référence ni sur facture ni sur candidat — match basé sur montant/date uniquement")

    # Vérifs TVA si on a HT et TTC
    if invoice.total_ht_eur and invoice.vat_eur:
        expected_ttc = invoice.total_ht_eur + invoice.vat_eur
        if abs(expected_ttc - invoice.total_ttc_eur) > Decimal("0.05"):
            discrepancies.append(
                f"Incohérence TVA : HT ({invoice.total_ht_eur}) + TVA ({invoice.vat_eur}) "
                f"= {expected_ttc} ≠ TTC déclaré ({invoice.total_ttc_eur})"
            )

    state["scored_candidates"] = scored
    state["best_match"] = best
    state["match_status"] = status
    state["discrepancies"] = discrepancies
    state["steps"] = state.get("steps", 0) + 1
    return state


async def assess_node(state: InvoiceState) -> InvoiceState:
    """Décision finale : LLM formule la recommandation."""
    req = state["request"]
    invoice = state["invoice_data"]
    best = state.get("best_match")
    status = state["match_status"]
    discrepancies = state.get("discrepancies", [])

    system = SystemMessage(content=(
        "Tu es un assistant comptable français. Sur la base d'un rapprochement "
        "facture / candidat (commande ou paiement), recommande UNE action : "
        "valider, enquêter, rejeter, ou demander_info. "
        "Réponds UNIQUEMENT avec un JSON conforme au schéma."
    ))

    discrepancies_str = "\n".join(f"- {d}" for d in discrepancies) or "(aucune)"

    if best:
        candidate_str = (
            f"Candidat retenu (type={best.candidate_type}, "
            f"id={best.candidate_id}) : montant {best.amount_eur} €, "
            f"date {best.date}, référence {best.reference or 'N/A'}, "
            f"score {best.score:.2f}"
        )
    else:
        candidate_str = "Aucun candidat ne correspond suffisamment."

    user_content = (
        f"Facture {req.invoice_type.value} : n°{invoice.invoice_number}, "
        f"montant {invoice.total_ttc_eur} € TTC, date {invoice.invoice_date}, "
        f"vendor {invoice.vendor_name or 'N/A'}, ref {invoice.reference or 'N/A'}\n\n"
        f"Statut du match : {status.value}\n"
        f"{candidate_str}\n\n"
        f"Anomalies détectées :\n{discrepancies_str}\n\n"
        "Donne ta recommandation."
    )

    assessment = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _Assessment,
        temperature=0.2,
    )
    state["assessment"] = assessment.model_dump()
    state["steps"] = state.get("steps", 0) + 1
    return state


# =============================================================================
# Graph builder
# =============================================================================

def build_invoice_graph():
    from app.persistence import get_checkpointer

    graph = StateGraph(InvoiceState)
    graph.add_node("extract", extract_node)
    graph.add_node("match", match_node)
    graph.add_node("assess", assess_node)

    graph.set_entry_point("extract")
    graph.add_edge("extract", "match")
    graph.add_edge("match", "assess")
    graph.add_edge("assess", END)

    return graph.compile(checkpointer=get_checkpointer())


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_invoice_graph()
    return _GRAPH


# =============================================================================
# Entry point
# =============================================================================

async def run(request: ReconcileInvoiceRequest, thread_id: str | None = None) -> ReconcileInvoiceResponse:
    s = get_settings()
    started = time.time()

    initial_state: InvoiceState = {
        "request": request,
        "started_at": started,
        "steps": 0,
        "discrepancies": [],
    }

    import uuid
    effective_thread_id = thread_id or f"ephemeral-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": effective_thread_id}}
    result_state = await get_graph().ainvoke(initial_state, config=config)
    duration_ms = int((time.time() - started) * 1000)

    best = result_state.get("best_match")
    status = result_state["match_status"]
    confidence = best.score if best else 0.0
    assessment = result_state["assessment"]

    # Override defensif : si pas un match EXACT ou si discrepancies présentes,
    # on force la validation humaine (sécurité comptable). Le LLM est faillible
    # sur ce flag, on prend pas de risque.
    discrepancies = result_state.get("discrepancies", [])
    needs_validation = (
        bool(assessment["needs_human_validation"])
        or status != MatchStatus.EXACT
        or len(discrepancies) > 0
    )

    return ReconcileInvoiceResponse(
        invoice_data=result_state["invoice_data"],
        best_match=best,
        match_status=status,
        confidence=confidence,
        discrepancies=discrepancies,
        recommended_action=assessment["recommended_action"],
        needs_human_validation=needs_validation,
        explanation=assessment["explanation"],
        metadata=GraphMetadata(
            graph_name="invoice_reconciliation",
            steps_executed=result_state.get("steps", 0),
            duration_ms=duration_ms,
            model_used=s.llm_main,
            backend=s.inference_backend,
        ),
    )
