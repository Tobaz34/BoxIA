/**
 * POST /api/connectors/[slug]/sync — déclenche un sync immédiat.
 *
 * Pour cette V1 : marque last_sync_at = now (no-op réel — le worker
 * connector réel n'est pas encore lancé en production sur la plupart
 * des connecteurs). Ça permet de valider l'UX bout en bout.
 *
 * V2 : enverra un signal Docker (kill -USR1) au container connector pour
 * forcer un sync, ou créera un job dans une queue Redis.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recordSyncStart, recordSyncSuccess } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await params;
  const spec = getConnector(slug);
  if (!spec) {
    return NextResponse.json({ error: "unknown_connector" }, { status: 404 });
  }

  await recordSyncStart(slug);
  // V1 : juste un mock — pas de worker réel à signaler ici
  await recordSyncSuccess(slug, {
    last_objects_added: 0,
    last_objects_removed: 0,
  });

  return NextResponse.json({
    ok: true,
    note: spec.implStatus !== "implemented"
      ? "Sync simulé. Le worker réel arrivera dans une prochaine version."
      : null,
  });
}
