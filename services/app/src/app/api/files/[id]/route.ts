/**
 * GET    /api/files/[id]   — télécharge un fichier généré par un agent.
 * DELETE /api/files/[id]   — supprime un fichier généré.
 *
 * Le fichier appartient au user qui l'a déclenché (session.user.email).
 * Un autre user reçoit 404 (pas 403 — ne pas leak l'existence).
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, deleteFile } from "@/lib/file-storage";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const result = await readFile(id, session.user.email);
  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { meta, buffer } = result;
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": meta.mime,
      "Content-Disposition":
        `attachment; filename="${encodeURIComponent(meta.filename)}"`,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ok = await deleteFile(id, session.user.email);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await logAction("rgpd.delete_conversations", `file:${id}`, {},
    ipFromHeaders(req));
  return NextResponse.json({ ok: true });
}
