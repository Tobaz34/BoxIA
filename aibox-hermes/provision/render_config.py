"""Génère le config.yaml d'un Hermes utilisateur avec RBAC par connecteur.

Pur & testable : seuls les connecteurs AUTORISÉS pour ce user apparaissent dans
`mcp_servers`. Un user sans droit sur un connecteur ne peut tout simplement pas
l'appeler — le tool n'existe pas dans sa config.
"""
from __future__ import annotations

import json
import os


def _envval(name: str) -> str:
    # hermes-webui ne résout PAS la syntaxe ${env:X} dans le bloc env: d'un
    # serveur MCP — il passe la chaîne littérale. On écrit donc la VRAIE valeur
    # (lue de l'environnement du wizard) dans config.yaml, comme le fait l'UI.
    return os.environ.get(name, "")


def _pennylane_block(tenant_dir: str, pennylane_base_url: str) -> str:
    return (
        '  pennylane:\n'
        f'    command: "{tenant_dir}/mcp-connectors/pennylane/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/pennylane/server.py"]\n'
        '    env:\n'
        f'      PENNYLANE_TOOL_BASE_URL: "{pennylane_base_url}"\n'
        f'      PENNYLANE_TOOL_API_KEY: {json.dumps(_envval("PENNYLANE_TOOL_API_KEY"))}\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


def _email_msgraph_block(tenant_dir: str, pennylane_base_url: str) -> str:
    # Boîtes M365 via Graph (app-only). Secrets résolus depuis ${HERMES_HOME}/.env.
    return (
        '  email-msgraph:\n'
        f'    command: "{tenant_dir}/mcp-connectors/email-msgraph/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/email-msgraph/server.py"]\n'
        '    env:\n'
        f'      MSGRAPH_TENANT_ID: {json.dumps(_envval("MSGRAPH_TENANT_ID"))}\n'
        f'      MSGRAPH_CLIENT_ID: {json.dumps(_envval("MSGRAPH_CLIENT_ID"))}\n'
        f'      MSGRAPH_CLIENT_SECRET: {json.dumps(_envval("MSGRAPH_CLIENT_SECRET"))}\n'
        f'      MSGRAPH_ALLOWED_MAILBOXES: {json.dumps(_envval("MSGRAPH_ALLOWED_MAILBOXES"))}\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


def _email_ews_block(tenant_dir: str, pennylane_base_url: str) -> str:
    # Boîte Exchange on-premise via EWS/NTLM. Secrets depuis ${HERMES_HOME}/.env.
    return (
        '  email-ews:\n'
        f'    command: "{tenant_dir}/mcp-connectors/email-ews/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/email-ews/server.py"]\n'
        '    env:\n'
        f'      EWS_ENDPOINT: {json.dumps(_envval("EWS_ENDPOINT"))}\n'
        f'      EWS_EMAIL: {json.dumps(_envval("EWS_EMAIL"))}\n'
        f'      EWS_USERNAME: {json.dumps(_envval("EWS_USERNAME"))}\n'
        f'      EWS_PASSWORD: {json.dumps(_envval("EWS_PASSWORD"))}\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


def _odoo_block(tenant_dir: str, pennylane_base_url: str) -> str:
    # Odoo via XML-RPC. Secrets depuis ${HERMES_HOME}/.env.
    return (
        '  odoo:\n'
        f'    command: "{tenant_dir}/mcp-connectors/odoo/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/odoo/server.py"]\n'
        '    env:\n'
        f'      ODOO_URL: {json.dumps(_envval("ODOO_URL"))}\n'
        f'      ODOO_DB: {json.dumps(_envval("ODOO_DB"))}\n'
        f'      ODOO_USERNAME: {json.dumps(_envval("ODOO_USERNAME"))}\n'
        f'      ODOO_API_KEY: {json.dumps(_envval("ODOO_API_KEY"))}\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


def _msfiles_block(tenant_dir: str, pennylane_base_url: str) -> str:
    # SharePoint/OneDrive via Graph — réutilise l'app email-msgraph (mêmes creds).
    return (
        '  msfiles:\n'
        f'    command: "{tenant_dir}/mcp-connectors/msfiles/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/msfiles/server.py"]\n'
        '    env:\n'
        f'      MSGRAPH_TENANT_ID: {json.dumps(_envval("MSGRAPH_TENANT_ID"))}\n'
        f'      MSGRAPH_CLIENT_ID: {json.dumps(_envval("MSGRAPH_CLIENT_ID"))}\n'
        f'      MSGRAPH_CLIENT_SECRET: {json.dumps(_envval("MSGRAPH_CLIENT_SECRET"))}\n'
        '    timeout: 60\n'
        '    tools: { resources: false, prompts: false }'
    )


def _himalaya_block(tenant_dir: str, pennylane_base_url: str) -> str:
    # Boîtes IMAP/SMTP via le CLI himalaya (Gmail, RideQuest). Pas de secret ici :
    # himalaya lit sa propre config (~/.config/himalaya/config.toml + fichiers .pass).
    # HOME est forcé pour que le connecteur (lancé par le process Hermes) trouve la config.
    return (
        '  himalaya:\n'
        f'    command: "{tenant_dir}/mcp-connectors/himalaya/.venv/bin/python"\n'
        f'    args: ["{tenant_dir}/mcp-connectors/himalaya/server.py"]\n'
        '    env:\n'
        f'      HIMALAYA_BIN: {json.dumps(_envval("HIMALAYA_BIN") or "/home/clikinfo/.local/bin/himalaya")}\n'
        f'      HIMALAYA_ACCOUNTS: {json.dumps(_envval("HIMALAYA_ACCOUNTS") or "gmail,ridequest")}\n'
        f'      HOME: {json.dumps(_envval("HIMALAYA_HOME") or "/home/clikinfo")}\n'
        '    timeout: 90\n'
        '    tools: { resources: false, prompts: false }'
    )


# Registre des connecteurs MCP connus → fonction qui rend leur bloc de config.
CONNECTORS = {
    "pennylane": _pennylane_block,
    "email-msgraph": _email_msgraph_block,
    "email-ews": _email_ews_block,
    "odoo": _odoo_block,
    "msfiles": _msfiles_block,
    "himalaya": _himalaya_block,
    # glpi / fec : à ajouter ici quand leurs shims MCP existent.
}

# Overlay de personnalité (agent.system_prompt) : produit français → réponses FR +
# unités métriques. Corrige notamment les sources web US (°F/mph) non converties.
# Concis mais avec une directive de recherche FORTE : sans « tu DOIS appeler
# web_search », les petits modèles (8b) répondent de mémoire et hallucinent les faits
# (faux articles de loi / fausses jurisprudences). La directive forte fait basculer
# le modèle vers la recherche. (Coût : un peu plus de délibération en mode thinking.)
DEFAULT_SYSTEM_PROMPT = (
    "Tu es l'assistant d'AI Box. Réponds en français, clair et concis, en unités "
    "métriques (°C, km/h, kg, €, dates JJ/MM/AAAA). "
    "RÈGLE ABSOLUE : pour toute question juridique, fiscale, réglementaire, chiffrée "
    "ou d'actualité, tu DOIS d'abord appeler l'outil web_search pour vérifier, puis "
    "citer la source. N'invente JAMAIS un article de loi, une jurisprudence, une date "
    "ni un chiffre — en cas de doute, cherche sur le web."
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
    cloud_fallback_model: str = "",
    cron_mode: str = "deny",
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
    # Fallback cloud (Claude). `hermes fallback add` est un picker interactif SANS
    # arguments (vérifié v0.16.0) — impossible à scripter. On écrit donc directement
    # `fallback_providers` (lu par hermes_cli/fallback_config.get_fallback_chain).
    # Déclenché quand le local échoue après retries (Ollama 500/EOF, surcharge…).
    # La clé vient de ANTHROPIC_API_KEY dans ${HERMES_HOME}/.env (jamais ici).
    fallback = (
        "fallback_providers:\n"
        '- provider: "anthropic"\n'
        f'  model: "{cloud_fallback_model}"\n\n'
    ) if cloud_fallback_model else ""
    return (
        "# Généré par render_config.py — ne pas éditer à la main.\n"
        "model:\n"
        '  provider: "custom"\n'
        f'  base_url: "{base_url}"\n'
        f'  default: "{model}"\n'
        "  context_length: 65536   # Hermes exige >=64K ; qwen3 natif=40K → override obligatoire\n\n"
        f"{fallback}"
        f"{vision}"
        f"{web}"
        "mcp_servers:\n"
        f"{mcp}\n\n"
        "skills:\n"
        "  external_dirs:\n"
        f'    - "{tenant_dir}/skills"\n\n'
        "group_sessions_per_user: true\n"
        "max_concurrent_sessions: null\n\n"
        # Politique d'approbation des runs déclenchés par le scheduler cron
        # (tâches planifiées / routines). "deny" = les actions sensibles (envoi
        # email, création/suppression…) sont auto-refusées → routine lecture+notif
        # seulement. "allow" = la routine agit seule sans validation. La livraison
        # d'un résumé (--deliver telegram/local) n'est PAS gated → marche même en deny.
        "approvals:\n"
        f'  cron_mode: "{cron_mode}"\n\n'
        "display:\n"
        "  tool_progress: new\n\n"
        "agent:\n"
        "  max_turns: 120\n"
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
    ap.add_argument("--cloud-fallback-model", default="",
                    help="modèle Claude en fallback du local, ex: claude-haiku-4-5 (vide = désactivé)")
    ap.add_argument("--cron-mode", default="deny", choices=["deny", "allow"],
                    help="politique des routines cron : deny=lecture+notif (sûr), allow=actions autonomes")
    a = ap.parse_args()
    conns = [c.strip() for c in a.connectors.split(",") if c.strip()]
    print(render(a.model, a.base_url, conns, a.tenant_dir, a.pennylane_base_url,
                 a.vision_model, a.search_backend,
                 cloud_fallback_model=a.cloud_fallback_model,
                 cron_mode=a.cron_mode))
