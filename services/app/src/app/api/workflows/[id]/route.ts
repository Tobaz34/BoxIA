/**
 * POST /api/workflows/[id]    body: { active: boolean } — admin only
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setWorkflowActive } from "@/lib/n8n";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let body: { active?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  const ok = await setWorkflowActive(id, !!body.active);
  if (!ok) {
    return NextResponse.json({ error: "n8n_error" }, { status: 502 });
  }
  await logAction("settings.update", `workflow:${id}`, {
    active: !!body.active,
  }, ipFromHeaders(req));
  return NextResponse.json({ ok: true });
}
