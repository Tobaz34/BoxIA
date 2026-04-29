/**
 * POST /api/connectors/[slug]/hide        body: { hidden: boolean }
 *
 * Permet à l'admin de masquer un connecteur du catalogue (le user n'a
 * pas à le voir dans /connectors). Réversible.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setHidden } from "@/lib/connectors-state";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
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
  let body: { hidden?: boolean };
  try {
    body = await req.json();
  } catch {
    body = { hidden: true };
  }
  await setHidden(slug, body.hidden !== false);
  return NextResponse.json({ ok: true });
}
