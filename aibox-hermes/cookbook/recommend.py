"""Cookbook AI Box — recommande le modèle Ollama local selon le hardware.

Idée reprise d'Odysseus (« Cookbook », VRAM-aware / fit-scoring) et ré-implémentée
pour notre install « 1 PC = 1 entreprise » : catalogue de modèles FR-friendly
(famille Qwen3) + heuristique de fit. Pur & testable (aucune I/O).
"""
from __future__ import annotations

# Empreintes À 64K DE CONTEXTE (Hermes exige >=64K → le KV-cache 64K s'ajoute aux
# poids). MESURÉ LIVE sur xefia (RTX 4070 Super 12 Go) : qwen3:8b à 64K = 11 Go
# (100% GPU, rapide).
# ⚠️ LE 14B A ÉTÉ TESTÉ ET REJETÉ SUR 12 Go (2026-06-15) : même avec KV q8_0 il
# reste à 90% GPU / 10% CPU (~27 tok/s, plus lent), son mode « thinking » sur-délibère
# (9 Ko de réflexion sur une tâche de code = ~90 s/tour), et basculer 14b↔8b fait
# planter le runner Ollama (OOM, 170 Mo libres). Le gain qualité (FR/raisonnement)
# ne compense pas. → sur 12 Go on RESTE sur le 8B. La fiabilité factuelle vient du
# system_prompt « web_search obligatoire », pas de la taille du modèle.
# min_vram_gb == 0 => modèle pensé pour tourner sur CPU.
CATALOG = [
    {"id": "qwen3:1.7b", "params_b": 1.7, "min_ram_gb": 5,  "min_vram_gb": 0,  "fr": 3, "tier": 1, "note": "ultra-léger, CPU"},
    {"id": "qwen3:4b",   "params_b": 4,   "min_ram_gb": 8,  "min_vram_gb": 0,  "fr": 4, "tier": 2, "note": "léger, CPU OK"},
    {"id": "qwen3:8b",   "params_b": 8,   "min_ram_gb": 16, "min_vram_gb": 11, "fr": 4, "tier": 3, "note": "GPU 12 Go — 64K, 100% GPU, rapide (recommandé sur 12 Go)"},
    {"id": "qwen3:14b",  "params_b": 14,  "min_ram_gb": 28, "min_vram_gb": 18, "fr": 5, "tier": 4, "note": "GPU 18-24 Go (sur 12 Go : trop lent + thinking verbeux, voir note)"},
    {"id": "qwen3:32b",  "params_b": 32,  "min_ram_gb": 48, "min_vram_gb": 30, "fr": 5, "tier": 5, "note": "GPU 32 Go+ à 64K"},
]

GPU_MIN_GB = 6.0  # en dessous : on considère qu'il n'y a pas de GPU utile


def _fits(m: dict, ram_gb: float, vram_gb: float, has_gpu: bool) -> bool:
    if has_gpu and m["min_vram_gb"] > 0:
        return m["min_vram_gb"] <= vram_gb and m["min_ram_gb"] <= ram_gb
    # machine CPU-only (ou modèle pensé CPU) : on exige min_vram_gb == 0
    if m["min_vram_gb"] == 0:
        return m["min_ram_gb"] <= ram_gb
    return False


def recommend(ram_gb: float, vram_gb: float = 0.0, prefer: str = "quality") -> dict:
    """Retourne le modèle recommandé + raison + alternatives.

    prefer="quality" → le plus capable qui tient ; "speed" → un cran en dessous.
    """
    has_gpu = vram_gb >= GPU_MIN_GB
    fitting = sorted(
        (m for m in CATALOG if _fits(m, ram_gb, vram_gb, has_gpu)),
        key=lambda m: m["tier"],
    )
    if not fitting:
        smallest = min(CATALOG, key=lambda m: m["tier"])
        return {
            "recommended": smallest["id"],
            "reason": "hardware très limité — modèle minimal (peut être lent)",
            "fits": False,
            "alternatives": [],
        }
    if prefer == "speed":
        choice = fitting[-2] if len(fitting) >= 2 else fitting[0]
    else:
        choice = fitting[-1]
    reason = (
        f"GPU {vram_gb:.0f} Go → {choice['id']} ({choice['note']})"
        if has_gpu
        else f"CPU, {ram_gb:.0f} Go RAM, pas de GPU utile → {choice['id']} ({choice['note']})"
    )
    return {
        "recommended": choice["id"],
        "reason": reason,
        "fits": True,
        "fr_quality": choice["fr"],
        "alternatives": [m["id"] for m in fitting if m["id"] != choice["id"]],
    }
