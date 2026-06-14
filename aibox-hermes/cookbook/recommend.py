"""Cookbook AI Box — recommande le modèle Ollama local selon le hardware.

Idée reprise d'Odysseus (« Cookbook », VRAM-aware / fit-scoring) et ré-implémentée
pour notre install « 1 PC = 1 entreprise » : catalogue de modèles FR-friendly
(famille Qwen3) + heuristique de fit. Pur & testable (aucune I/O).
"""
from __future__ import annotations

# Empreintes ~Q4 (Ollama). min_vram_gb == 0 => modèle pensé pour tourner sur CPU.
CATALOG = [
    {"id": "qwen3:1.7b", "params_b": 1.7, "min_ram_gb": 4,  "min_vram_gb": 0,  "fr": 3, "tier": 1, "note": "ultra-léger, CPU"},
    {"id": "qwen3:4b",   "params_b": 4,   "min_ram_gb": 8,  "min_vram_gb": 0,  "fr": 4, "tier": 2, "note": "léger, CPU OK"},
    {"id": "qwen3:8b",   "params_b": 8,   "min_ram_gb": 12, "min_vram_gb": 6,  "fr": 4, "tier": 3, "note": "bon compromis (GPU 6-8 Go)"},
    {"id": "qwen3:14b",  "params_b": 14,  "min_ram_gb": 24, "min_vram_gb": 10, "fr": 5, "tier": 4, "note": "qualité FR (GPU 12 Go)"},
    {"id": "qwen3:32b",  "params_b": 32,  "min_ram_gb": 48, "min_vram_gb": 22, "fr": 5, "tier": 5, "note": "haut de gamme (GPU 24 Go+)"},
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
