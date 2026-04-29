"""
Provisionne une source d'identité dans Authentik (Azure AD / Google / LDAP / OIDC).

Au lieu d'un container long-running, ce script s'exécute une fois après le
wizard pour créer la source via l'API Authentik. Idempotent : si la source
existe déjà, mise à jour des champs.

Usage :
  python provision.py AZURE_AD
  python provision.py GOOGLE
  python provision.py LDAP
  python provision.py OIDC --provider-name=okta

Variables d'env (toutes lues depuis /srv/ai-stack/.env) :
  - AUTHENTIK_URL        (par défaut http://aibox-authentik-server:9000)
  - AUTHENTIK_API_TOKEN  (token superuser)
  - selon mode :
      AZURE_AD : AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
      GOOGLE   : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
      LDAP     : LDAP_SERVER_URI, LDAP_BIND_DN, LDAP_BIND_PASSWORD,
                 LDAP_BASE_DN, LDAP_USER_DN_TEMPLATE
      OIDC     : OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
"""
from __future__ import annotations

import argparse
import os
import sys
import httpx

API = os.environ.get("AUTHENTIK_URL", "http://aibox-authentik-server:9000") + "/api/v3"
TOKEN = os.environ["AUTHENTIK_API_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def upsert(endpoint: str, slug: str, payload: dict) -> dict:
    """Crée ou met à jour un objet identifiable par son slug."""
    with httpx.Client(headers=H, timeout=30) as c:
        r = c.get(f"{API}/{endpoint}/?slug={slug}")
        r.raise_for_status()
        results = r.json().get("results", [])
        if results:
            pk = results[0]["pk"]
            r = c.patch(f"{API}/{endpoint}/{pk}/", json=payload)
        else:
            r = c.post(f"{API}/{endpoint}/", json=payload)
        r.raise_for_status()
        return r.json()


def provision_azure_ad() -> None:
    src = upsert("sources/oauth", "ms-entra", {
        "name": "Microsoft Entra ID",
        "slug": "ms-entra",
        "enabled": True,
        "user_matching_mode": "email_link",
        "provider_type": "azuread",
        "consumer_key": os.environ["AZURE_CLIENT_ID"],
        "consumer_secret": os.environ["AZURE_CLIENT_SECRET"],
        "additional_scopes": "User.Read",
        # tenant id passé via le provider : remplir authorize_url manuellement
        "authorization_url": f"https://login.microsoftonline.com/{os.environ['AZURE_TENANT_ID']}/oauth2/v2.0/authorize",
        "access_token_url":  f"https://login.microsoftonline.com/{os.environ['AZURE_TENANT_ID']}/oauth2/v2.0/token",
        "profile_url":       "https://graph.microsoft.com/oidc/userinfo",
    })
    print("✓ Azure AD source créée :", src["pk"])


def provision_google() -> None:
    src = upsert("sources/oauth", "google", {
        "name": "Google Workspace",
        "slug": "google",
        "enabled": True,
        "user_matching_mode": "email_link",
        "provider_type": "google",
        "consumer_key": os.environ["GOOGLE_CLIENT_ID"],
        "consumer_secret": os.environ["GOOGLE_CLIENT_SECRET"],
        "additional_scopes": "openid email profile",
    })
    print("✓ Google source créée :", src["pk"])


def provision_ldap() -> None:
    src = upsert("sources/ldap", "ad-local", {
        "name": "Active Directory",
        "slug": "ad-local",
        "enabled": True,
        "server_uri": os.environ["LDAP_SERVER_URI"],
        "bind_cn": os.environ["LDAP_BIND_DN"],
        "bind_password": os.environ["LDAP_BIND_PASSWORD"],
        "base_dn": os.environ["LDAP_BASE_DN"],
        "additional_user_dn": "CN=Users",
        "additional_group_dn": "CN=Users",
        "user_object_filter": "(objectClass=person)",
        "group_object_filter": "(objectClass=group)",
        "sync_users": True,
        "sync_groups": True,
    })
    print("✓ LDAP source créée :", src["pk"])


def provision_oidc(provider_name: str = "oidc-custom") -> None:
    src = upsert("sources/oauth", provider_name, {
        "name": f"OIDC {provider_name}",
        "slug": provider_name,
        "enabled": True,
        "user_matching_mode": "email_link",
        "provider_type": "openidconnect",
        "consumer_key": os.environ["OIDC_CLIENT_ID"],
        "consumer_secret": os.environ["OIDC_CLIENT_SECRET"],
        "oidc_well_known_url": f"{os.environ['OIDC_ISSUER']}/.well-known/openid-configuration",
        "additional_scopes": "openid email profile",
    })
    print(f"✓ OIDC source ({provider_name}) créée :", src["pk"])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["AZURE_AD", "GOOGLE", "LDAP", "OIDC"])
    p.add_argument("--provider-name", default="oidc-custom")
    args = p.parse_args()
    try:
        if args.mode == "AZURE_AD": provision_azure_ad()
        elif args.mode == "GOOGLE": provision_google()
        elif args.mode == "LDAP":   provision_ldap()
        elif args.mode == "OIDC":   provision_oidc(args.provider_name)
    except KeyError as e:
        print(f"ERREUR : variable d'environnement manquante : {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
