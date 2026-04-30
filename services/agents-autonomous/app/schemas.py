"""Pydantic schemas — entrée et sortie de chaque agent autonome.

Ces schemas servent à 3 choses :
1. Validation FastAPI à l'entrée (POST body)
2. Structured output côté LLM (vLLM guided_json ou Ollama format=json + retry)
3. Documentation OpenAPI auto-générée (consommée par Dify pour brancher les tools)

Convention : tout est en français côté valeurs métier (catégories, priorités)
parce que le LLM travaille en français → meilleur taux de réussite que de le
forcer à mapper FR → EN.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field, field_validator


# =============================================================================
# Communs
# =============================================================================

class GraphMetadata(BaseModel):
    """Méta-données ajoutées par l'orchestrateur, présentes dans toutes les
    réponses, pour traçabilité côté Dify et debugging."""
    graph_name: str
    steps_executed: int
    duration_ms: int
    model_used: str
    backend: str


# =============================================================================
# Agent 1 — Triage email
# =============================================================================
# Workflow LangGraph :
#   classify → (priority + intent) → draft_reply → suggest_actions → END
#
# Décision Dify côté UI :
#   - Si confidence < 0.7 : on demande validation humaine avant action
#   - Sinon : on peut auto-router (Slack, draft Outlook, ticket GLPI)

class EmailCategory(str, Enum):
    COMMERCIAL = "commercial"           # demande de devis, prospection, vente
    SUPPORT = "support"                 # demande d'aide technique
    ADMINISTRATIF = "administratif"     # facture, contrat, RH
    INTERNE = "interne"                 # collègue
    SPAM = "spam"
    NEWSLETTER = "newsletter"
    AUTRE = "autre"


class EmailPriority(str, Enum):
    URGENT = "urgent"          # action requise dans la journée
    HAUTE = "haute"            # action requise sous 48h
    NORMALE = "normale"        # action requise sous une semaine
    BASSE = "basse"            # peut attendre
    INFO = "info"              # pas d'action attendue


class EmailAction(str, Enum):
    REPONDRE = "repondre"
    TRANSFERER = "transferer"
    ARCHIVER = "archiver"
    SUPPRIMER = "supprimer"
    CREER_TICKET = "creer_ticket"
    PLANIFIER_RDV = "planifier_rdv"
    DEVIS_A_GENERER = "devis_a_generer"


class TriageEmailRequest(BaseModel):
    """Email entrant à trier — schéma agnostique (IMAP, MS Graph, Gmail…)."""
    sender: EmailStr
    sender_name: str | None = None
    recipients: list[EmailStr] = Field(default_factory=list)
    subject: str
    body: Annotated[str, Field(min_length=1, max_length=50_000)]
    received_at: datetime
    has_attachments: bool = False
    thread_history: list[str] = Field(
        default_factory=list,
        description="Messages précédents du fil pour contexte (résumés, max 5).",
    )

    @field_validator("body")
    @classmethod
    def strip_body(cls, v: str) -> str:
        return v.strip()


class SuggestedAction(BaseModel):
    action: EmailAction
    rationale: str = Field(..., description="Pourquoi cette action, en 1 phrase")
    target: str | None = Field(
        None,
        description="Cible de l'action (email du destinataire, queue ticket, etc.)",
    )


class TriageEmailResponse(BaseModel):
    category: EmailCategory
    priority: EmailPriority
    confidence: float = Field(..., ge=0.0, le=1.0)
    intent: str = Field(..., description="Résumé en 1 phrase du besoin émetteur")
    summary: str = Field(..., description="Synthèse du contenu en 2-3 phrases")
    contains_pii: bool = Field(False, description="Contient des données personnelles RGPD")
    contains_phishing_signals: bool = False
    suggested_reply: str | None = Field(
        None,
        description="Brouillon de réponse en français (vide si action != REPONDRE)",
    )
    suggested_actions: list[SuggestedAction] = Field(default_factory=list, max_length=3)
    needs_human_validation: bool = Field(
        ...,
        description="True si confidence basse ou enjeu élevé (montant, juridique, RH)",
    )
    metadata: GraphMetadata | None = None


# =============================================================================
# Agent 2 — Génération de devis
# =============================================================================
# Workflow LangGraph :
#   parse_brief → identify_items → estimate_pricing → format_quote → END
#
# Le brief est en langage naturel ("besoin d'un site vitrine 5 pages,
# WordPress, formulaire contact, livraison sous 6 semaines").

class CustomerInfo(BaseModel):
    name: str
    email: EmailStr | None = None
    company: str | None = None
    siret: str | None = None
    address: str | None = None


class QuoteLineItem(BaseModel):
    description: str
    quantity: float = Field(1.0, gt=0)
    unit: str = Field("forfait", description="heure, jour, forfait, unité, m², etc.")
    unit_price_eur: Decimal = Field(..., ge=0, decimal_places=2)
    total_eur: Decimal = Field(..., ge=0, decimal_places=2)
    notes: str | None = None


class GenerateQuoteRequest(BaseModel):
    brief: Annotated[str, Field(min_length=20, max_length=20_000)]
    customer: CustomerInfo
    company_context: str | None = Field(
        None,
        description="Contexte entreprise (secteur, tarifs habituels, conditions). "
                    "Injecté dans le prompt LLM. Idéalement renseigné par le RAG.",
    )
    currency: str = Field("EUR", pattern="^[A-Z]{3}$")
    vat_rate_percent: float = Field(20.0, ge=0, le=100)
    valid_until_days: int = Field(30, ge=1, le=365)


class GenerateQuoteResponse(BaseModel):
    quote_number: str = Field(..., description="Format DEV-YYYYMMDD-XXX")
    customer: CustomerInfo
    issue_date: date
    valid_until: date
    line_items: list[QuoteLineItem] = Field(..., min_length=1)
    subtotal_eur: Decimal = Field(..., ge=0, decimal_places=2)
    vat_eur: Decimal = Field(..., ge=0, decimal_places=2)
    total_eur: Decimal = Field(..., ge=0, decimal_places=2)
    payment_terms: str = Field("30 jours fin de mois", description="Conditions de paiement")
    notes: str | None = Field(None, description="Notes additionnelles, hypothèses, exclusions")
    confidence: float = Field(..., ge=0.0, le=1.0)
    needs_human_review: bool = Field(
        ...,
        description="True si total > 10k€ OU brief ambigu OU confidence basse",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Points d'attention pour le commercial (info manquante, hypothèse forte)",
    )
    metadata: GraphMetadata | None = None


# =============================================================================
# Agent 3 — Rapprochement facture
# =============================================================================
# Workflow LangGraph :
#   extract_invoice_data → match_purchase_order → match_payment → assess → END
#
# Cas réels TPE/PME :
# - Facture fournisseur reçue → matcher avec bon de commande + bon de réception
# - Facture client → matcher avec règlement bancaire (virement, prélèvement)

class InvoiceType(str, Enum):
    FOURNISSEUR = "fournisseur"
    CLIENT = "client"


class MatchStatus(str, Enum):
    EXACT = "exact"                # match parfait montant + date + référence
    PARTIEL = "partiel"            # 1 ou 2 critères manquent
    DIVERGENT = "divergent"        # match probable mais écart à investiguer
    INTROUVABLE = "introuvable"    # rien ne correspond


class InvoiceData(BaseModel):
    """Données structurées extraites de la facture."""
    invoice_number: str
    invoice_date: date
    due_date: date | None = None
    vendor_name: str | None = None
    vendor_siret: str | None = None
    customer_name: str | None = None
    total_ht_eur: Decimal | None = Field(None, decimal_places=2)
    total_ttc_eur: Decimal = Field(..., decimal_places=2)
    vat_eur: Decimal | None = Field(None, decimal_places=2)
    reference: str | None = Field(None, description="Réf. commande/devis si présente")


class CandidateMatch(BaseModel):
    candidate_id: str = Field(..., description="ID externe (BDC, virement, etc.)")
    candidate_type: str = Field(..., description="purchase_order | payment | invoice")
    amount_eur: Decimal = Field(..., decimal_places=2)
    date: date
    reference: str | None = None
    score: float = Field(..., ge=0.0, le=1.0, description="Score de similarité")
    delta_eur: Decimal = Field(Decimal("0"), decimal_places=2, description="Écart de montant")
    delta_days: int = Field(0, description="Écart en jours entre dates")


class ReconcileInvoiceRequest(BaseModel):
    invoice_type: InvoiceType
    invoice_text: Annotated[str, Field(min_length=10, max_length=50_000)] = Field(
        ..., description="Texte OCR de la facture OU JSON déjà extrait"
    )
    invoice_data: InvoiceData | None = Field(
        None,
        description="Si fourni, on saute l'étape extraction (use case avancé)",
    )
    candidates: list[CandidateMatch] = Field(
        default_factory=list,
        description="Candidats pré-filtrés (BDC, paiements) à rapprocher",
        max_length=50,
    )


class ReconcileInvoiceResponse(BaseModel):
    invoice_data: InvoiceData
    best_match: CandidateMatch | None = None
    match_status: MatchStatus
    confidence: float = Field(..., ge=0.0, le=1.0)
    discrepancies: list[str] = Field(
        default_factory=list,
        description="Anomalies détectées : montant écart, date, TVA non standard, etc.",
    )
    recommended_action: str = Field(
        ...,
        description="Action à mener : valider | enquêter | rejeter | demander info",
    )
    needs_human_validation: bool
    explanation: str = Field(..., description="Explication courte du raisonnement")
    metadata: GraphMetadata | None = None
