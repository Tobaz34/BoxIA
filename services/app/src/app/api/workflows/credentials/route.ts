/**
 * GET /api/workflows/credentials — liste les credentials n8n (lecture seule).
 * POST /api/workflows/credentials — re-pousse vers n8n les credentials de
 *   tous les connecteurs BoxIA actifs dont on connaît le mapper (form ou
 *   OAuth). Utile après un upgrade d'aibox-app ou pour forcer un refresh.
 *
 * Admin only. Aucun secret retourné — juste nom + type + dates.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listCredentials } from "@/lib/n8n";
import { pushAllBridgedCredentials } from "@/lib/n8n-credentials";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const credentials = await listCredentials();
  return NextResponse.json({ credentials });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const pushed = await pushAllBridgedCredentials();
    await logAction(
      "workflow.credentials_resync",
      session.user.email,
      { pushed_count: pushed.length, slugs: pushed },
      ipFromHeaders(req),
    );
    return NextResponse.json({ ok: true, pushed });
  } catch (e) {
    return NextResponse.json(
      { error: "resync_failed", detail: String(e).slice(0, 300) },
      { status: 500 },
    );
  }
}
