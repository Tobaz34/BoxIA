/**
 * GET /api/workflows/credentials — liste les credentials n8n (lecture seule).
 * Admin only. Aucun secret retourné — juste nom + type + dates.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listCredentials } from "@/lib/n8n";

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
