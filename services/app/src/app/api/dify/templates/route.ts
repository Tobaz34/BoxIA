/**
 * GET /api/dify/templates — liste les templates Dify Explorer.
 * Admin only (provisionnement = action sensible).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listTemplates } from "@/lib/dify-marketplace";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const data = await listTemplates();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: "dify_unreachable", detail: String(e).slice(0, 300) },
      { status: 502 },
    );
  }
}
