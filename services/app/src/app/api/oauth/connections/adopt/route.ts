/**
 * POST /api/oauth/connections/adopt
 * body: { source_id: "google:google-drive", target_slug: "gmail-workspace" }
 *
 * Copie le token + scopes d'une connexion OAuth source vers un autre
 * connector_slug du même provider. Sert au cas où l'admin a déjà connecté
 * Google Drive et veut activer Gmail/Calendar sans repasser le consent.
 *
 * Garde-fous :
 *   - source.provider doit matcher le provider du target_slug
 *   - target_slug doit être un sibling déclaré dans connector_scopes
 *     (sinon on ne sait pas si le token couvre les scopes nécessaires)
 *   - On ne peut pas écraser une connexion target avec un account différent
 *
 * Pas de re-fetch /token côté provider — on copie tel quel l'access_token
 * (déjà chiffré), expires_at, refresh_token. À l'expiration, le mécanisme
 * de refresh standard prend le relais.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { _readStore, _writeStore, type OAuthConnection } from "@/lib/oauth-storage";
import { OAUTH_PROVIDERS, siblingSlugs } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    source_id?: string;
    target_slug?: string;
  };
  const sourceId = String(body.source_id || "");
  const targetSlug = String(body.target_slug || "");
  if (!sourceId || !targetSlug) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const store = await _readStore();
  const source = store.connections[sourceId];
  if (!source) {
    return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  }

  const provider = OAUTH_PROVIDERS[source.provider_id];
  if (!provider) {
    return NextResponse.json({ error: "provider_disappeared" }, { status: 500 });
  }

  // Le target doit être un sibling déclaré (sinon on ne sait pas si les
  // scopes du source token couvrent les besoins du target).
  const siblings = siblingSlugs(source.provider_id);
  if (!siblings.includes(targetSlug)) {
    return NextResponse.json(
      { error: "target_not_sibling", supported: siblings },
      { status: 400 },
    );
  }

  // Vérifie que le token source a des scopes qui couvrent au moins une
  // partie des besoins du target (approximation : on accepte tant que
  // les scopes target ne sont pas vides — l'API du worker plantera
  // explicitement si un scope manque).
  const targetScopes = provider.connector_scopes?.[targetSlug] || [];
  const sourceScopes = new Set(source.scopes || []);
  const sharedScopes = targetScopes.filter((s) => sourceScopes.has(s));
  if (targetScopes.length > 0 && sharedScopes.length === 0) {
    return NextResponse.json(
      {
        error: "scopes_mismatch",
        hint: `Le token source n'a aucun scope en commun avec ${targetSlug}. ` +
              `Il faut reconnecter avec ?broad=1 (default).`,
        source_scopes: Array.from(sourceScopes),
        target_scopes_required: targetScopes,
      },
      { status: 400 },
    );
  }

  const targetId = `${source.provider_id}:${targetSlug}`;
  const existing = store.connections[targetId];
  if (existing && existing.account_email && source.account_email
      && existing.account_email !== source.account_email) {
    return NextResponse.json(
      {
        error: "account_mismatch",
        hint: `Le slug ${targetSlug} est déjà connecté avec ${existing.account_email}. ` +
              `Déconnecte-le d'abord si tu veux passer à ${source.account_email}.`,
      },
      { status: 409 },
    );
  }

  const adopted: OAuthConnection = {
    id: targetId,
    provider_id: source.provider_id,
    connector_slug: targetSlug,
    scopes: targetScopes.length > 0 ? targetScopes : source.scopes,
    access_token_encrypted: source.access_token_encrypted,
    refresh_token_encrypted: source.refresh_token_encrypted,
    expires_at: source.expires_at,
    account_email: source.account_email,
    account_name: source.account_name,
    connected_at: existing?.connected_at || Date.now(),
    connected_by: session.user.email,
    last_refreshed_at: Date.now(),
  };
  store.connections[targetId] = adopted;
  await _writeStore(store);

  await logAction(
    "settings.update",
    `oauth_oidc_adopted:${source.provider_id}:${source.connector_slug}->${targetSlug}`,
    {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      account: source.account_email,
    },
  );

  return NextResponse.json({
    ok: true,
    connection: {
      id: adopted.id,
      provider_id: adopted.provider_id,
      connector_slug: adopted.connector_slug,
      account_email: adopted.account_email,
      account_name: adopted.account_name,
      scopes: adopted.scopes,
      connected_at: adopted.connected_at,
      expires_at: adopted.expires_at,
    },
  });
}
