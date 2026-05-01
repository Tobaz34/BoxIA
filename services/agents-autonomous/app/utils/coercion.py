"""Coercions et normalisation défensive sur sortie LLM 7B.

Les modèles 7B (Qwen2.5, Llama 3.1) divergent fréquemment du schéma demandé :
- Renommage des clés en français ("résumé" au lieu de "summary")
- Wrap inattendu dans un objet racine ({"output": {...}})
- Listes de dicts là où on attend des listes de strings
- Catégorisation imbriquée ({"delays": [...], "tech": [...]})

Ces helpers absorbent ces dérives en pré-validation Pydantic, pour économiser
les retries LLM coûteux (10-20s chacun).

Pour vLLM avec guided_json (tier pme/+), ces coercions sont des no-op :
le JSON est déjà strictement conforme.
"""
from __future__ import annotations

# Mapping clés FR/synonymes → EN canonique. Étendre au fur et à mesure
# qu'on observe de nouvelles dérives en prod. Toutes les clés en lower-case.
DEFAULT_KEY_MAP: dict[str, str] = {
    # Email triage
    "categorie": "category",
    "catégorie": "category",
    "priorite": "priority",
    "priorité": "priority",
    "confiance": "confidence",
    "confidence": "confidence",
    "intention": "intent",
    "intent": "intent",
    "résumé": "summary",
    "resume": "summary",
    "synthèse": "summary",
    "summary": "summary",
    "contient_pii": "contains_pii",
    "contient_phishing": "contains_phishing_signals",
    "phishing": "contains_phishing_signals",
    "action_suggérée": "suggested_action",
    "action_suggeree": "suggested_action",
    "action": "suggested_action",
    "rationale": "rationale",
    "raison": "rationale",
    "justification": "rationale",

    # Quote generator
    "livrables": "deliverables",
    "produits": "deliverables",
    "deliverables": "deliverables",
    "contraintes": "constraints",
    "constraints": "constraints",
    "secteur": "sector",
    "domaine": "sector",
    "sector": "sector",
    "ambiguïtés": "ambiguities",
    "ambiguites": "ambiguities",
    "questions": "ambiguities",
    "ambiguities": "ambiguities",
    "lignes": "items",
    "lignesdevis": "items",
    "lignes_devis": "items",
    "lignes_de_devis": "items",
    "items": "items",
    "articles": "items",
    "postes": "items",
    "elements": "items",
    "éléments": "items",
    "description": "description",
    "desc": "description",
    "libellé": "description",
    "libelle": "description",
    "quantité": "quantity",
    "quantite": "quantity",
    "qty": "quantity",
    "quantity": "quantity",
    "unité": "unit",
    "unite": "unit",
    "unit": "unit",
    "prix_unitaire": "unit_price_eur",
    "prix": "unit_price_eur",
    "unit_price": "unit_price_eur",
    "unit_price_eur": "unit_price_eur",
    "price": "unit_price_eur",
    "notes": "notes",
    "note": "notes",
    "remarque": "notes",
    "pricing_rationale": "pricing_rationale",
    "score_confidence": "confidence",
    "prices": "prices",

    # Invoice reconciliation
    "numero_facture": "invoice_number",
    "n_facture": "invoice_number",
    "invoice_number": "invoice_number",
    "date_facture": "invoice_date",
    "invoice_date": "invoice_date",
    "date_echeance": "due_date",
    "échéance": "due_date",
    "echeance": "due_date",
    "due_date": "due_date",
    "fournisseur": "vendor_name",
    "vendor": "vendor_name",
    "vendor_name": "vendor_name",
    "siret_fournisseur": "vendor_siret",
    "vendor_siret": "vendor_siret",
    "client": "customer_name",
    "customer_name": "customer_name",
    "total_ht": "total_ht_eur",
    "totalht": "total_ht_eur",
    "total_ht_eur": "total_ht_eur",
    "ht": "total_ht_eur",
    "total_ttc": "total_ttc_eur",
    "totalttc": "total_ttc_eur",
    "total_ttc_eur": "total_ttc_eur",
    "ttc": "total_ttc_eur",
    "tva": "vat_eur",
    "vat": "vat_eur",
    "vat_eur": "vat_eur",
    "reference": "reference",
    "référence": "reference",
    "ref": "reference",
    "ref_commande": "reference",
    "recommended_action": "recommended_action",
    "action_recommandée": "recommended_action",
    "action_recommandee": "recommended_action",
    "explanation": "explanation",
    "explication": "explanation",
    "needs_human_validation": "needs_human_validation",
    "validation_humaine": "needs_human_validation",
}

# Wrappers que le LLM peut introduire : on les déballe au top-level
WRAPPER_KEYS = {"output", "result", "data", "response", "json", "answer", "content", "value"}


def normalize_keys(d, key_map: dict[str, str] | None = None, _depth: int = 0):
    """Recurse sur dict/list pour normaliser FR → EN.

    Bonus : si le LLM wrap tout dans un seul objet racine du genre
    `{"output": {...}}` ou `{"result": {...}}`, on déballe automatiquement.
    """
    km = key_map or DEFAULT_KEY_MAP
    if isinstance(d, dict):
        if _depth == 0 and len(d) == 1:
            only_key = next(iter(d.keys())).lower()
            if only_key in WRAPPER_KEYS:
                return normalize_keys(next(iter(d.values())), km, _depth)
        return {km.get(k.lower(), k): normalize_keys(v, km, _depth + 1) for k, v in d.items()}
    if isinstance(d, list):
        return [normalize_keys(x, km, _depth + 1) for x in d]
    return d


def coerce_str_list(v):
    """Force `v` en list[str], absorbant dicts/strings/None/scalars.

    Cas absorbés :
    - ["a", "b"]                                 → tel quel
    - [{"k": "v"}, ...]                           → ["k: v", ...]
    - {"cat1": [...], "cat2": [...]}              → flatten avec préfixe catégorie
    - {"key": "val"}                              → ["key: val"]
    - "single string"                             → ["single string"]
    - None / scalar                               → [] / [str(v)]
    """
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        out = []
        for k, val in v.items():
            if isinstance(val, list):
                for item in val:
                    out.append(f"{k}: {item}")
            elif isinstance(val, dict):
                parts = [f"{kk}={vv}" for kk, vv in val.items()]
                out.append(f"{k}: {', '.join(parts)}")
            else:
                out.append(f"{k}: {val}")
        return out
    if isinstance(v, list):
        out = []
        for item in v:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                parts = [f"{k}: {val}" for k, val in item.items()]
                out.append(" — ".join(parts))
            else:
                out.append(str(item))
        return out
    return [str(v)]


def autodetect_list_field(d: dict, target_field: str, item_marker_keys: tuple[str, ...]) -> dict:
    """Si `target_field` absent mais qu'on trouve une liste de dicts ressemblant
    aux items attendus (présence d'au moins une `item_marker_keys`), on l'adopte.

    Utile quand le LLM nomme la liste différemment (lignes_devis, postes, etc.)
    """
    if not isinstance(d, dict) or target_field in d:
        return d
    for k, val in d.items():
        if isinstance(val, list) and val and isinstance(val[0], dict):
            if any(key in val[0] for key in item_marker_keys):
                d[target_field] = val
                break
    return d
