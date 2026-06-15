"""Cookbook AI Box — recommande le modèle Ollama local selon le hardware.

Idée reprise d'Odysseus (« Cookbook », VRAM-aware / fit-scoring) et ré-implémentée
pour notre install « 1 PC = 1 entreprise » : catalogue de modèles FR-friendly
(famille Qwen3) + heuristique de fit. Pur & testable (aucune I/O).
"""
from __future__ import annotations

# Empreintes À 64K DE CONTEXTE (Hermes exige >=64K → le KV-cache 64K s'ajoute aux
# poids). Le service Ollama tourne avec OLLAMA_KV_CACHE_TYPE=q8_0 + FLASH_ATTENTION
# (posé par install.sh) → le cache KV est ~2× plus compact, ce qui fait tenir le 14B
# sur 12 Go. MESURÉ LIVE sur xefia (RTX 4070 Super 12 Go) : qwen3:8b à 64K = 11 Go
# (100% GPU) ; qwen3:14b à 64K avec KV q8_0 = 13 Go → 90% GPU / 10% CPU, ~27 tok/s
# (fluide). Sans le KV q8_0 le 14B débordait (~73% GPU, lent).
# min_vram_gb == 0 => modèle pensé pour tourner sur CPU.
CATALOG = [
    {"id": "qwen3:1.7b", "params_b": 1.7, "min_ram_gb": 5,  "min_vram_gb": 0,  "fr": 3, "tier": 1, "note": "ultra-léger, CPU"},
    {"id": "qwen3:4b",   "params_b": 4,   "min_ram_gb": 8,  "min_vram_gb": 0,  "fr": 4, "tier": 2, "note": "léger, CPU OK"},
    {"id": "qwen3:8b",   "params_b": 8,   "min_ram_gb": 16, "min_vram_gb": 8,  "fr": 4, "tier": 3, "note": "GPU 8-11 Go — 64K, 100% GPU"},
    {"id": "qwen3:14b",  "params_b": 14,  "min_ram_gb": 24, "min_vram_gb": 12, "fr": 5, "tier": 4, "note": "GPU 12 Go — 64K avec cache KV q8_0, ~27 tok/s (meilleur FR/raisonnement)"},
    {"id": "qwen3:32b",  "params_b": 32,  "min_ram_gb": 48, "min_vram_gb": 24, "fr": 5, "tier": 5, "note": "GPU 24 Go+ à 64K"},
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
