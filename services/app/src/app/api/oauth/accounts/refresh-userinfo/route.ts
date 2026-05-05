/**
 * POST /api/oauth/accounts/refresh-userinfo
 *
 * Re-fetch userinfo (Google /oauth2/v3/userinfo, Microsoft /v1.0/me)
 * pour toutes les connexions OAuth qui n'ont PAS de account_email.
 *
 * Cas d'usage : connexions créées avant l'ajout de User.Read aux
 * default_scopes Microsoft (cf oauth-providers.ts) — elles ont un
 * access_token valide mais pas d'identité associée → l'UI affiche
 * juste "Connecté" sans préciser le compte.
 *
 * Idempotent. Best-effort : une connexion qui rate l'userinfo (token
 * expiré, scopes manquants) est laissée inchangée.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { _readStore, _writeStore, decryptToken } from "@/lib/oauth-storage";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  // ?force=1 pour ré-hydrater même celles qui ont déjà un email
  const force = url.searchParams.get("force") === "1";

  const store = await _readStore();
  const results: Array<{
    id: string;
    before: string | null;
    after: string | null;
    error?: string;
  }> = [];

  for (const id of Object.keys(store.connections)) {
    const c = store.connections[id];
    if (c.account_email && !force) continue;

    const provider = OAUTH_PROVIDERS[c.provider_id];
    if (!provider?.userinfo_endpoint) {
      results.push({ id, before: c.account_email || null, after: null,
                     error: "no_userinfo_endpoint" });
      continue;
    }

    let accessToken: string | null;
    try {
      accessToken = decryptToken(c.access_token_encrypted);
    } catch (e) {
      results.push({ id, before: c.account_email || null, after: null,
                     error: `decrypt: ${(e as Error).message}` });
      continue;
    }
    if (!accessToken) {
      results.push({ id, before: c.account_email || null, after: null,
                     error: "decrypt_returned_null" });
      continue;
    }

    try {
      const r = await fetch(provider.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) {
        results.push({
          id, before: c.account_email || null, after: null,
          error: `userinfo_${r.status}`,
        });
        continue;
      }
      const j = await r.json();
      const email = j.email || j.mail || j.userPrincipalName || null;
      const name = j.name || j.displayName || undefined;
      if (email) {
        store.connections[id] = {
          ...c,
          account_email: email,
          account_name: name,
        };
      }
      results.push({
        id,
        before: c.account_email || null,
        after: email,
        error: email ? undefined : "no_email_in_payload",
      });
    } catch (e) {
      results.push({
        id, before: c.account_email || null, after: null,
        error: (e as Error).message,
      });
    }
  }

  await _writeStore(store);

  const updated = results.filter((r) => r.after && r.after !== r.before).length;
  await logAction(
    "settings.update",
    `oauth_userinfo_refreshed`,
    {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      updated,
      total_processed: results.length,
    },
  );

  return NextResponse.json({ ok: true, updated, results });
}
