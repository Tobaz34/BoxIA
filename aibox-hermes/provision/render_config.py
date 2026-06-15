"""Génère le config.yaml d'un Hermes utilisateur avec RBAC par connecteur.

Pur & testable : seuls les connecteurs AUTORISÉS pour ce user apparaissent dans
`mcp_servers`. Un user sans droit sur un connecteur ne peut tout simplement pas
l'appeler — le tool n'existe pas dans sa config.
"""
from __future__ import annotations

import json


def _pennylane_block(tenant_dir: str, pennylane_base_url: str) -> str:
    return (
        '  pennylane:\n'
        f'    command: "{tenant_dir}/mcp-connectors/pennylane/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/pennylane/server.py"]\n'
        '    env:\n'
        f'      PENNYLANE_TOOL_BASE_URL: "{pennylane_base_url}"\n'
        '      PENNYLANE_TOOL_API_KEY: "${env:PENNYLANE_TOOL_API_KEY}"\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


# Registre des connecteurs MCP connus → fonction qui rend leur bloc de config.
CONNECTORS = {
    "pennylane": _pennylane_block,
    # odoo / glpi / fec : à ajouter ici quand leurs shims MCP existent.
}

# Overlay de personnalité (agent.system_prompt) : produit français → réponses FR +
# unités métriques. Corrige notamment les sources web US (°F/mph) non converties.
DEFAULT_SYSTEM_PROMPT = (
    "Tu es l'assistant IA d'AI Box, pour une entreprise française. Réponds toujours "
    "en français, de manière claire, concise et professionnelle. Utilise "
    "systématiquement les unités françaises et métriques : températures en °C, "
    "distances en km, vitesses en km/h, poids en kg, montants en euros (€), dates au "
    "format JJ/MM/AAAA. Lorsqu'une recherche web ou une source étrangère donne des "
    "valeurs dans d'autres unités (°F, miles, mph, livres, dollars), convertis-les en "
    "unités françaises avant de répondre, et cite la source. "
    "IMPORTANT — fiabilité : pour toute question juridique, réglementaire, fiscale, "
    "financière chiffrée, technique pointue ou d'actualité, utilise l'outil de "
    "recherche web (web_search) pour VÉRIFIER avant de répondre, puis cite tes sources. "
    "N'invente JAMAIS un numéro d'article de loi, une date, un taux ou un chiffre : si "
    "tu n'es pas certain, cherche sur le web ou dis clairement que tu n'es pas sûr."
)


def render(
    model: str,
    base_url: str,
    connectors,
    tenant_dir: str,
    pennylane_base_url: str = "http://127.0.0.1:8081",
    vision_model: str = "qwen2.5vl:7b",
    search_backend: str = "ddgs",
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
) -> str:
    allowed = [c for c in connectors if c in CONNECTORS]
    blocks = "\n".join(CONNECTORS[c](tenant_dir, pennylane_base_url) for c in allowed)
    mcp = blocks if blocks else "  {}"
    # Modèle vision dédié (pièces jointes image) : tâche auxiliaire routée vers un
    # modèle multimodal local. Sans ça, qwen3 (text-only) « ne peut pas voir » l'image.
    vision = (
        "auxiliary:\n"
        "  vision:\n"
        '    provider: "custom"\n'
        f'    base_url: "{base_url}"\n'
        f'    model: "{vision_model}"\n'
        '    api_key: "ollama"\n\n'
    ) if vision_model else ""
    # Recherche web. `ddgs` (DuckDuckGo) ne demande AUCUNE clé API → activable d'office,
    # recherche seule (pas d'extraction). Pour une meilleure qualité + extraction,
    # passer plus tard à tavily/brave/firecrawl (clé dans .env) sans toucher ce bloc.
    # IMPORTANT : on écrit `web.backend` (et NON `web.search_backend`). Hermes n'expose
    # l'outil `web_search` que si `check_web_api_key()` voit un backend dispo, et cette
    # fonction lit `web.backend`. Mettre seulement `search_backend` → l'outil reste caché.
    web = (
        "web:\n"
        f'  backend: "{search_backend}"\n\n'
    ) if search_backend else ""
    return (
        "# Généré par render_config.py — ne pas éditer à la main.\n"
        "model:\n"
        '  provider: "custom"\n'
        f'  base_url: "{base_url}"\n'
        f'  default: "{model}"\n'
        "  context_length: 65536   # Hermes exige >=64K ; qwen3 natif=40K → override obligatoire\n\n"
        f"{vision}"
        f"{web}"
        "mcp_servers:\n"
        f"{mcp}\n\n"
        "skills:\n"
        "  external_dirs:\n"
        f'    - "{tenant_dir}/skills"\n\n'
        "group_sessions_per_user: true\n"
        "max_concurrent_sessions: null\n\n"
        "display:\n"
        "  tool_progress: new\n\n"
        "agent:\n"
        "  max_turns: 40\n"
        '  reasoning_effort: "medium"\n'
        + (f"  system_prompt: {json.dumps(system_prompt, ensure_ascii=False)}\n" if system_prompt else "")
    )


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Génère config.yaml Hermes (RBAC connecteurs)")
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:11434/v1")
    ap.add_argument("--connectors", default="", help="csv des connecteurs autorisés")
    ap.add_argument("--tenant-dir", required=True)
    ap.add_argument("--pennylane-base-url", default="http://127.0.0.1:8081")
    ap.add_argument("--vision-model", default="qwen2.5vl:7b",
                    help="modèle vision pour les pièces jointes image (vide = désactivé)")
    ap.add_argument("--search-backend", default="ddgs",
                    help="backend recherche web (ddgs=DuckDuckGo sans clé ; vide = désactivé)")
    a = ap.parse_args()
    conns = [c.strip() for c in a.connectors.split(",") if c.strip()]
    print(render(a.model, a.base_url, conns, a.tenant_dir, a.pennylane_base_url,
                 a.vision_model, a.search_backend))
