/**
 * GET /api/app-audit — log d'audit applicatif (en plus des events Authentik).
 *
 * Source : `/data/audit.jsonl`. Tracé : connector.*, document.*, rgpd.*,
 * user.*, settings.*, etc. (les events authentification sont laissés à
 * Authentik).
 *
 * Admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAudit } from "@/lib/app-audit";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || undefined;
  const actor = searchParams.get("actor") || undefined;
  const limit = Number(searchParams.get("limit") || "200");

  const entries = await readAudit({ action, actor, limit });
  // Trace l'accès à l'audit lui-même (méta)
  await logAction("audit.access", undefined,
    { count: entries.length, filter: { action, actor } },
    ipFromHeaders(req),
  );
  return NextResponse.json({ entries });
}
