/**
 * POST /api/oauth/accounts/sync-activations
 *
 * Pour chaque connexion OAuth existante (`oauth-connections.json`),
 * marque le connector correspondant comme `status: "active"` dans
 * connector-state si ce n'est pas déjà fait.
 *
 * Cas d'usage : connexions créées AVANT le patch d'auto-activate
 * du callback OAuth (cf oauth-oidc.ts). L'admin avait un compte
 * Microsoft connecté mais seul SharePoint apparaissait dans la sidebar
 * (les autres slugs siblings — Outlook, Calendar, Teams — restaient
 * `inactive`).
 *
 * Idempotent. Best-effort : un slug sans spec catalog est skippé.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { _readStore } from "@/lib/oauth-storage";
import { activateConnector, listStates } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const store = await _readStore();
  const states = await listStates();

  const results: Array<{ slug: string; before: string; after: string; error?: string }> = [];
  const seen = new Set<string>();

  for (const conn of Object.values(store.connections)) {
    const slug = conn.connector_slug;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const spec = getConnector(slug);
    if (!spec) {
      results.push({ slug, before: "n/a", after: "skipped", error: "no_spec_in_catalog" });
      continue;
    }

    const beforeStatus = states[slug]?.status || "inactive";
    if (beforeStatus === "active") {
      results.push({ slug, before: "active", after: "active" });
      continue;
    }

    try {
      const next = await activateConnector(slug, {});
      results.push({ slug, before: beforeStatus, after: next.status });
    } catch (e) {
      results.push({
        slug,
        before: beforeStatus,
        after: beforeStatus,
        error: (e as Error).message,
      });
    }
  }

  const activated = results.filter((r) => r.after === "active" && r.before !== "active").length;
  await logAction("settings.update", `oauth_sync_activations`, {
    actor: session.user.email,
    ip: ipFromHeaders(req),
    activated,
    total_processed: results.length,
  });

  return NextResponse.json({ ok: true, activated, results });
}
