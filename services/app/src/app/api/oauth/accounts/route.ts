/**
 * GET /api/oauth/accounts
 *
 * Vue agrégée des connexions OAuth, regroupées par (provider, account_email).
 * Permet à l'UI d'afficher "1 compte Microsoft = 5 services" au lieu de
 * lister 5 entrées séparées sans vue d'ensemble.
 *
 * DELETE /api/oauth/accounts?provider=microsoft&email=a.ladurelle@clikinfo.fr
 *
 * Déconnecte le compte ENTIER (cascade sur tous les sibling slugs qui
 * partagent ce account_email pour ce provider). Utile quand l'admin veut
 * vraiment se déconnecter (vs déconnecter juste OneDrive en gardant
 * Outlook+Calendar — ce que fait DELETE /api/oauth/connections?id=…).
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { _readStore, _writeStore, type OAuthConnection } from "@/lib/oauth-storage";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

interface AccountSummary {
  provider_id: OAuthProviderId;
  provider_name: string;
  account_email: string | null;
  account_name?: string;
  connected_at: number;
  last_refreshed_at?: number;
  expires_at?: number;
  /** Slugs liés à ce compte (couvre OneDrive + Outlook + Calendar etc.) */
  slugs: string[];
  /** Union des scopes accordés par toutes les connexions liées. */
  scopes: string[];
}

/** Regroupe les connexions par (provider, account_email). */
function groupConnections(conns: OAuthConnection[]): AccountSummary[] {
  const groups = new Map<string, AccountSummary>();
  for (const c of conns) {
    // Si account_email est null on regroupe quand même par provider — ça
    // permet au backfill de cibler ces connexions orphelines.
    const key = `${c.provider_id}::${c.account_email || "_unknown"}`;
    const provider = OAUTH_PROVIDERS[c.provider_id];
    if (!groups.has(key)) {
      groups.set(key, {
        provider_id: c.provider_id,
        provider_name: provider?.name || c.provider_id,
        account_email: c.account_email || null,
        account_name: c.account_name,
        connected_at: c.connected_at,
        last_refreshed_at: c.last_refreshed_at,
        expires_at: c.expires_at,
        slugs: [],
        scopes: [],
      });
    }
    const g = groups.get(key)!;
    g.slugs.push(c.connector_slug);
    for (const s of c.scopes || []) {
      if (!g.scopes.includes(s)) g.scopes.push(s);
    }
    // On garde la connexion la plus récemment refresh
    if ((c.last_refreshed_at || 0) > (g.last_refreshed_at || 0)) {
      g.last_refreshed_at = c.last_refreshed_at;
      g.expires_at = c.expires_at;
      if (c.account_name) g.account_name = c.account_name;
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) => (b.last_refreshed_at || b.connected_at) -
              (a.last_refreshed_at || a.connected_at),
  );
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const store = await _readStore();
  const accounts = groupConnections(Object.values(store.connections));
  return NextResponse.json({ accounts });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const providerRaw = url.searchParams.get("provider");
  const emailParam = url.searchParams.get("email");
  if (!providerRaw) {
    return NextResponse.json({ error: "missing_provider" }, { status: 400 });
  }
  if (providerRaw !== "google" && providerRaw !== "microsoft") {
    return NextResponse.json({ error: "unsupported_provider" }, { status: 400 });
  }
  const provider = providerRaw as OAuthProviderId;

  const store = await _readStore();
  const removed: string[] = [];
  for (const id of Object.keys(store.connections)) {
    const c = store.connections[id];
    if (c.provider_id !== provider) continue;
    // Si email fourni : matcher exact. Si null fourni explicitement :
    // matcher les connexions sans email (orphelines).
    const matchEmail = emailParam === null
      ? true // pas de filtre
      : emailParam === ""
        ? !c.account_email
        : c.account_email === emailParam;
    if (!matchEmail) continue;
    delete store.connections[id];
    removed.push(id);
  }
  await _writeStore(store);

  await logAction(
    "settings.update",
    `oauth_account_disconnected:${provider}:${emailParam || "_all"}`,
    {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      removed_count: removed.length,
      removed_ids: removed,
    },
  );

  return NextResponse.json({ ok: true, removed });
}
