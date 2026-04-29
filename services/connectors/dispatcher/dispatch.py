#!/usr/bin/env python3
"""
AI Box — Dispatcher de connecteurs.

Lit `client_config.yaml` et déduit la liste des connecteurs à activer.
Chaque réponse du questionnaire essentiel a un mapping vers un ou plusieurs
connecteurs (catalog `services/connectors/CATALOG.md`).

Usage:
  python dispatch.py --plan          # affiche ce qui serait lancé
  python dispatch.py --apply         # docker compose up sur chaque connecteur
  python dispatch.py --stop          # docker compose down sur tout
  python dispatch.py --reconcile     # apply + stop des connecteurs qui ne sont plus dans le config
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

CONNECTORS_DIR = Path(__file__).resolve().parent.parent
AIBOX_ROOT = Path(os.environ.get("AIBOX_ROOT", "/srv/ai-stack"))
CLIENT_CONFIG = AIBOX_ROOT / "client_config.yaml"
ENV_FILE = AIBOX_ROOT / ".env"


# Mapping : (question_id, valeur_choisie) → liste de connecteurs Docker à lancer
# Chaque entrée pointe vers un dossier `services/connectors/<id>/` qui contient
# son propre docker-compose.yml.
ACTIVATION_MAP: dict[tuple[str, str], list[str]] = {
    # Stockage docs
    ("stockage_docs", "sharepoint"): ["rag-msgraph"],
    ("stockage_docs", "gdrive"):     ["rag-gdrive"],
    ("stockage_docs", "nas_smb"):    ["rag-smb"],
    ("stockage_docs", "nextcloud"):  ["rag-nextcloud"],

    # Messagerie
    ("messagerie", "m365"):            ["email-msgraph"],
    ("messagerie", "gmail"):           ["email-gmail"],
    ("messagerie", "imap"):            ["email-imap"],
    ("messagerie", "exchange_onprem"): ["email-exchange-onprem"],

    # ERP / CRM
    ("erp_crm", "odoo"):       ["erp-odoo"],
    ("erp_crm", "salesforce"): ["crm-salesforce"],
    ("erp_crm", "hubspot"):    ["crm-hubspot"],
    ("erp_crm", "sage"):       ["erp-sage"],
    ("erp_crm", "pipedrive"):  ["crm-pipedrive"],
    ("erp_crm", "dynamics"):   ["erp-dynamics"],

    # Identité (sources Authentik)
    ("identite", "azure_ad"): ["authentik-source", "AZURE_AD"],
    ("identite", "google"):   ["authentik-source", "GOOGLE"],
    ("identite", "ad_local"): ["authentik-source", "LDAP"],
    ("identite", "okta"):     ["authentik-source", "OIDC"],

    # BI
    ("bi", "powerbi"):  ["bi-powerbi-agent"],
    ("bi", "metabase"): ["bi-metabase-agent"],

    # Bases SQL
    ("bases_sql", "postgres"): ["text2sql-postgres"],
    ("bases_sql", "mysql"):    ["text2sql-mysql"],
    ("bases_sql", "mssql"):    ["text2sql-mssql"],

    # Téléphonie
    ("telephonie", "3cx"):      ["telephony-3cx"],
    ("telephonie", "wildix"):   ["telephony-wildix"],
    ("telephonie", "ringover"): ["telephony-ringover"],

    # Helpdesk
    ("helpdesk", "internal_tool"): ["helpdesk-agent"],
}


@dataclass
class Activation:
    connector: str       # nom du dossier services/connectors/<x>
    extra_args: list[str] = None


def load_config() -> dict:
    if not CLIENT_CONFIG.exists():
        print(f"ERREUR : {CLIENT_CONFIG} introuvable. Lance le wizard d'abord.", file=sys.stderr)
        sys.exit(1)
    with CLIENT_CONFIG.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def plan(config: dict) -> list[Activation]:
    techs = config.get("technologies", {}) or {}
    activations: list[Activation] = []
    for question_id, value in techs.items():
        if not value or value in ("none", False):
            continue
        key = (question_id, value)
        spec = ACTIVATION_MAP.get(key)
        if not spec:
            continue
        connector = spec[0]
        extra = spec[1:] if len(spec) > 1 else []
        activations.append(Activation(connector=connector, extra_args=extra))
    return activations


def connector_exists(name: str) -> bool:
    return (CONNECTORS_DIR / name / "docker-compose.yml").is_file()


def compose_cmd(connector: str, action: str) -> list[str]:
    """Construit la commande docker compose pour ce connecteur."""
    return [
        "docker", "compose",
        "--project-directory", str(CONNECTORS_DIR / connector),
        "--env-file", str(ENV_FILE),
        action, "-d" if action == "up" else "",
    ]


def apply(activations: list[Activation], dry_run: bool = False) -> None:
    for a in activations:
        if not connector_exists(a.connector):
            print(f"  ⊘ {a.connector} — pas encore implémenté (squelette manquant)")
            continue
        print(f"  ▶ {a.connector}" + (f" [{','.join(a.extra_args or [])}]" if a.extra_args else ""))
        if dry_run:
            continue
        try:
            subprocess.run(
                ["docker", "compose", "-f",
                 str(CONNECTORS_DIR / a.connector / "docker-compose.yml"),
                 "--env-file", str(ENV_FILE), "up", "-d"],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(f"    ✗ erreur : {e}", file=sys.stderr)


def stop_all() -> None:
    """Stop tous les connecteurs (utile pour reconfigurer)."""
    for d in CONNECTORS_DIR.iterdir():
        if (d / "docker-compose.yml").is_file():
            subprocess.run(
                ["docker", "compose", "-f", str(d / "docker-compose.yml"), "down"],
                check=False,
            )


def main() -> None:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true", help="Affiche la liste sans rien faire")
    g.add_argument("--apply", action="store_true", help="Lance les connecteurs activés")
    g.add_argument("--stop", action="store_true", help="Stop tous les connecteurs")
    args = p.parse_args()

    if args.stop:
        stop_all()
        return

    config = load_config()
    activations = plan(config)

    print(f"Client     : {config.get('client', {}).get('name', '?')}")
    print(f"Connecteurs à activer : {len(activations)}")
    apply(activations, dry_run=args.plan)


if __name__ == "__main__":
    main()
