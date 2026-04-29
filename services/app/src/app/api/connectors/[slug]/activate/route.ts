/**
 * POST /api/connectors/[slug]/activate
 * body: { config: Record<string, string> }
 *
 * Active (ou reconfigure) un connecteur. Admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activateConnector } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = (session.user as { isAdmin?: boolean })?.isAdmin;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  const spec = getConnector(slug);
  if (!spec) {
    return NextResponse.json({ error: "unknown_connector" }, { status: 404 });
  }

  let body: { config?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  try {
    const next = await activateConnector(slug, body.config || {});
    return NextResponse.json({
      ok: true,
      slug: next.slug,
      status: next.status,
      activated_at: next.activated_at,
      impl_status: spec.implStatus,
      note: spec.implStatus !== "implemented"
        ? "Connecteur enregistré mais le worker n'est pas encore implémenté côté backend. " +
          "La configuration sera utilisée dès que le connecteur sera disponible."
        : null,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: "activation_failed", message: (e as Error).message },
      { status: 400 },
    );
  }
}
