"""Agent 2 — Génération de devis depuis brief client.

Workflow figé : parse_brief → identify_items → estimate_pricing → finalize → END

Décomposition pourquoi :
- parse_brief : extrait les besoins et contraintes du brief libre
- identify_items : convertit en lignes structurées (description, quantité, unité)
- estimate_pricing : calcule le prix unitaire (utilise company_context si fourni)
- finalize : numérotation, dates, totaux HT/TVA/TTC, score confidence

Le total HT/TVA/TTC est calculé en Python (pas par le LLM) — fiabilité 100%.
"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.utils.coercion import autodetect_list_field, coerce_str_list, normalize_keys

from app.config import get_settings
from app.llm import structured_invoke
from app.schemas import (
    CustomerInfo,
    GenerateQuoteRequest,
    GenerateQuoteResponse,
    GraphMetadata,
    QuoteLineItem,
)

logger = logging.getLogger(__name__)

# Seuil au-dessus duquel un humain doit valider avant envoi (configurable plus tard)
HIGH_VALUE_THRESHOLD_EUR = Decimal("10000.00")
# Au-delà : on considère le LLM hallucine sur le prix unitaire et on flag
SUSPICIOUS_UNIT_PRICE_EUR = Decimal("50000.00")
SUSPICIOUS_LINE_TOTAL_EUR = Decimal("100000.00")


# =============================================================================
# State
# =============================================================================

class QuoteState(TypedDict, total=False):
    request: GenerateQuoteRequest
    parsed_brief: dict
    raw_items: list[dict]       # avant pricing
    priced_items: list[QuoteLineItem]
    warnings: list[str]
    confidence: float
    started_at: float
    steps: int


# =============================================================================
# Schemas locaux pour les sorties intermédiaires
# =============================================================================

class _ParsedBrief(BaseModel):
    model_config = ConfigDict(extra="ignore")

    summary: str = Field(..., description="Résumé du besoin en 1-2 phrases")
    deliverables: list[str] = Field(..., description="Livrables identifiés")
    constraints: list[str] = Field(default_factory=list, description="Délais, contraintes techniques")
    sector: str | None = Field(None, description="Secteur d'activité si déductible")
    ambiguities: list[str] = Field(
        default_factory=list,
        description="Points flous nécessitant clarification client",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)

    @field_validator("deliverables", "constraints", "ambiguities", mode="before")
    @classmethod
    def _coerce(cls, v):
        return coerce_str_list(v)


class _RawItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    description: str = Field(..., min_length=5)
    quantity: float = Field(1.0, gt=0)
    unit: str = Field("forfait")
    notes: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


class _RawItemList(BaseModel):
    model_config = ConfigDict(extra="ignore")
    items: list[_RawItem] = Field(..., min_length=1, max_length=20)

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        v = normalize_keys(v)
        return autodetect_list_field(v, "items", ("description", "desc", "name", "label"))


class _PriceEntry(BaseModel):
    """Une entrée de prix indexée pour fiabiliser l'alignement avec raw_items."""
    model_config = ConfigDict(extra="ignore")
    index: int = Field(..., ge=0, description="Index de la ligne (0-based)")
    unit_price_eur: float = Field(..., ge=0)
    notes: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        return normalize_keys(v)


class _PriceList(BaseModel):
    """Schéma simplifié : juste les prix indexés + métadonnées globales.

    Le but : minimiser la surface où le LLM peut diverger. Pas besoin de
    redemander description/quantity/unit qu'on a déjà dans raw_items.
    """
    model_config = ConfigDict(extra="ignore")
    prices: list[_PriceEntry] = Field(..., min_length=1, max_length=20)
    pricing_rationale: str = Field("", description="Brève justification de la grille tarifaire")
    confidence: float = Field(0.7, ge=0.0, le=1.0)

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, v):
        v = normalize_keys(v)
        return autodetect_list_field(v, "prices", ("unit_price_eur", "price", "prix"))


# =============================================================================
# Nœuds
# =============================================================================

async def parse_brief_node(state: QuoteState) -> QuoteState:
    """Extraction structurée du brief libre."""
    req = state["request"]

    system = SystemMessage(content=(
        "Tu es un assistant commercial français spécialisé en TPE/PME. "
        "Lis le brief client et extrais les éléments structurés. "
        "Réponds UNIQUEMENT avec un objet JSON plat (PAS de wrapper), "
        "exactement dans ce format :\n"
        '{\n'
        '  "summary": "Phrase résumant le besoin",\n'
        '  "deliverables": ["Livrable 1 en phrase complète", "Livrable 2..."],\n'
        '  "constraints": ["Contrainte 1 en phrase", "Contrainte 2..."],\n'
        '  "sector": "secteur ou null",\n'
        '  "ambiguities": ["Question 1 à clarifier", "..."]\n'
        '}\n'
        "Toutes les listes contiennent UNIQUEMENT des chaînes de caractères, "
        "JAMAIS d'objets ni de tableaux imbriqués. Si vide, mettre []."
    ))

    user_content = (
        f"Brief client :\n{req.brief}\n\n"
        f"Client : {req.customer.name}"
        f"{' (' + req.customer.company + ')' if req.customer.company else ''}\n\n"
        "Génère le JSON dans le format indiqué."
    )

    parsed = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _ParsedBrief,
        temperature=0.2,
    )
    state["parsed_brief"] = parsed.model_dump()
    state["warnings"] = list(parsed.ambiguities)
    state["steps"] = state.get("steps", 0) + 1
    return state


async def identify_items_node(state: QuoteState) -> QuoteState:
    """Convertit les livrables en lignes de devis (sans prix encore)."""
    req = state["request"]
    parsed = state["parsed_brief"]

    system = SystemMessage(content=(
        "Tu es un assistant commercial français. Convertis les livrables en lignes "
        "de devis détaillées (description, quantité, unité). "
        "1 ligne par poste de travail. Unités possibles : heure, jour, forfait, "
        "unité, m², licence, mois. Réponds UNIQUEMENT avec un JSON conforme au schéma."
    ))

    deliverables = "\n".join(f"- {d}" for d in parsed["deliverables"])
    constraints = "\n".join(f"- {c}" for c in parsed.get("constraints", [])) or "(aucune)"

    user_content = (
        f"Brief résumé : {parsed['summary']}\n\n"
        f"Livrables :\n{deliverables}\n\n"
        f"Contraintes :\n{constraints}\n\n"
        "Génère la liste structurée des lignes de devis."
    )

    raw = await structured_invoke(
        [system, HumanMessage(content=user_content)],
        _RawItemList,
        temperature=0.2,
    )
    state["raw_items"] = [item.model_dump() for item in raw.items]
    state["steps"] = state.get("steps", 0) + 1
    return state


async def estimate_pricing_node(state: QuoteState) -> QuoteState:
    """Estime un prix unitaire pour chaque ligne (utilise company_context si fourni)."""
    req = state["request"]
    raw_items = state["raw_items"]

    system = SystemMessage(content=(
        "Tu es un assistant commercial français qui produit des estimations tarifaires "
        "réalistes pour le marché TPE/PME français. "
        "Si un contexte entreprise est fourni avec une grille tarifaire, RESPECTE-LA. "
        "Sinon, utilise des fourchettes de marché plausibles. "
        "Réponds UNIQUEMENT avec un JSON conforme au schéma."
    ))

    items_str = "\n".join(
        f"  {i}. {it['description']} ({it['quantity']} {it['unit']})"
        for i, it in enumerate(raw_items)
    )
    context = req.company_context or "(aucun contexte fourni — utilise les prix de marché FR)"

    system_pricing = SystemMessage(content=(
        "Tu es un assistant tarification pour TPE/PME française. "
        "Pour chaque ligne numérotée fournie, donne UNIQUEMENT son prix unitaire en euros HT. "
        "Réponds avec ce JSON exact, plat, sans wrapper :\n"
        '{\n'
        '  "prices": [\n'
        '    {"index": 0, "unit_price_eur": 1500.0, "notes": "optionnel"},\n'
        '    {"index": 1, "unit_price_eur": 800.0, "notes": null}\n'
        '  ],\n'
        '  "pricing_rationale": "Brève justification globale",\n'
        '  "confidence": 0.85\n'
        '}\n'
        "Un objet par ligne, dans l'ordre. L'index correspond au numéro de la ligne (0-based)."
    ))

    user_content = (
        f"Lignes à estimer :\n{items_str}\n\n"
        f"Contexte entreprise :\n{context}\n\n"
        f"Génère les {len(raw_items)} prix au format demandé."
    )

    priced = await structured_invoke(
        [system_pricing, HumanMessage(content=user_content)],
        _PriceList,
        temperature=0.3,
    )

    # Indexation par index pour résilience à un ordre mélangé par le LLM
    price_map = {p.index: p for p in priced.prices}

    line_items: list[QuoteLineItem] = []
    for i, raw in enumerate(raw_items):
        # Fallback : si l'index n'est pas trouvé, on prend l'i-ème prix de la liste
        p = price_map.get(i) or (priced.prices[i] if i < len(priced.prices) else None)
        if p is None:
            # Aucun prix trouvé pour cette ligne — flag dans warnings
            state["warnings"].append(
                f"⚠ Pas de prix généré pour la ligne {i+1} : {raw['description']}"
            )
            continue
        unit_price = Decimal(str(p.unit_price_eur)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        qty = Decimal(str(raw["quantity"]))
        total = (unit_price * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        line_items.append(QuoteLineItem(
            description=raw["description"],
            quantity=raw["quantity"],
            unit=raw["unit"],
            unit_price_eur=unit_price,
            total_eur=total,
            notes=raw.get("notes") or p.notes,
        ))

    state["priced_items"] = line_items
    state["confidence"] = priced.confidence
    if priced.pricing_rationale:
        state["warnings"].append(f"Méthode de pricing : {priced.pricing_rationale}")

    if not req.company_context:
        state["warnings"].append(
            "⚠ Aucun contexte tarifaire entreprise fourni — prix issus de fourchettes "
            "de marché, à valider commercialement."
        )

    state["steps"] = state.get("steps", 0) + 1
    return state


async def finalize_node(state: QuoteState) -> QuoteState:
    """Calculs déterministes (totaux, dates, n° devis) — pas de LLM ici."""
    # Tout est déjà prêt, finalize_node ne fait rien LLM, c'est run() qui assemble.
    state["steps"] = state.get("steps", 0) + 1
    return state


# =============================================================================
# Graph builder
# =============================================================================

def build_quote_graph():
    from app.persistence import get_checkpointer

    graph = StateGraph(QuoteState)
    graph.add_node("parse_brief", parse_brief_node)
    graph.add_node("identify_items", identify_items_node)
    graph.add_node("estimate_pricing", estimate_pricing_node)
    graph.add_node("finalize", finalize_node)

    graph.set_entry_point("parse_brief")
    graph.add_edge("parse_brief", "identify_items")
    graph.add_edge("identify_items", "estimate_pricing")
    graph.add_edge("estimate_pricing", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile(checkpointer=get_checkpointer())


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_quote_graph()
    return _GRAPH


# =============================================================================
# Entry point
# =============================================================================

async def run(request: GenerateQuoteRequest, thread_id: str | None = None) -> GenerateQuoteResponse:
    s = get_settings()
    started = time.time()

    initial_state: QuoteState = {
        "request": request,
        "started_at": started,
        "steps": 0,
        "warnings": [],
    }

    import uuid
    effective_thread_id = thread_id or f"ephemeral-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": effective_thread_id}}
    result_state = await get_graph().ainvoke(initial_state, config=config)
    duration_ms = int((time.time() - started) * 1000)

    line_items: list[QuoteLineItem] = result_state["priced_items"]
    subtotal = sum((li.total_eur for li in line_items), start=Decimal("0"))
    vat = (subtotal * Decimal(str(request.vat_rate_percent)) / Decimal("100")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    total = (subtotal + vat).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    today = date.today()
    quote_number = f"DEV-{today.strftime('%Y%m%d')}-{str(int(started) % 1000).zfill(3)}"

    confidence = float(result_state.get("confidence", 0.7))
    high_value = total >= HIGH_VALUE_THRESHOLD_EUR
    parsed = result_state.get("parsed_brief", {})
    has_ambiguities = bool(parsed.get("ambiguities"))

    # Sanity checks : flag les valeurs aberrantes qui trahissent une hallucination
    suspicious_lines = []
    for li in line_items:
        if li.unit_price_eur >= SUSPICIOUS_UNIT_PRICE_EUR or li.total_eur >= SUSPICIOUS_LINE_TOTAL_EUR:
            suspicious_lines.append(
                f"Ligne « {li.description[:60]} » : "
                f"prix unitaire {li.unit_price_eur} € × {li.quantity} {li.unit} "
                f"= {li.total_eur} € (suspect, à vérifier)"
            )
    if suspicious_lines:
        result_state["warnings"].extend(
            ["⚠ Valeurs suspectes détectées (probable hallucination LLM) :"] + suspicious_lines
        )

    has_suspicious = bool(suspicious_lines)
    needs_review = high_value or has_ambiguities or confidence < 0.65 or has_suspicious

    if high_value:
        result_state["warnings"].append(
            f"⚠ Devis > {HIGH_VALUE_THRESHOLD_EUR} € — validation commerciale recommandée."
        )

    return GenerateQuoteResponse(
        quote_number=quote_number,
        customer=request.customer,
        issue_date=today,
        valid_until=today + timedelta(days=request.valid_until_days),
        line_items=line_items,
        subtotal_eur=subtotal,
        vat_eur=vat,
        total_eur=total,
        payment_terms="30 jours fin de mois",
        notes=parsed.get("summary"),
        confidence=confidence,
        needs_human_review=needs_review,
        warnings=result_state.get("warnings", []),
        metadata=GraphMetadata(
            graph_name="quote_generator",
            steps_executed=result_state.get("steps", 0),
            duration_ms=duration_ms,
            model_used=s.llm_main,
            backend=s.inference_backend,
        ),
    )
