/**
 * POST /api/files/upload (multipart) — upload un fichier (image) à Dify
 * pour qu'on puisse ensuite l'inclure dans une chat-messages.
 *
 * body: FormData avec un champ "file" + champ "agent" (slug)
 *
 * Retourne le file_id Dify, à passer au prochain /api/chat dans :
 *   files: [{ type: "image", transfer_method: "local_file",
 *             upload_file_id: <id> }]
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, DIFY_BASE_URL } from "@/lib/dify";

export const dynamic = "force-dynamic";

// Limite raisonnable pour le multipart (5 Mo image)
export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  const incoming = await req.formData();
  const agent = incoming.get("agent") as string | null;
  const file = incoming.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "unsupported_type", message: "Image uniquement (JPG, PNG, WebP)." },
      { status: 415 },
    );
  }
  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json(
      { error: "too_large", message: "Image trop grande (max 8 Mo)." },
      { status: 413 },
    );
  }

  const ctx = await requireDifyContext(agent);
  if (ctx instanceof NextResponse) return ctx;

  // Re-encode le multipart pour Dify avec le user (requis par /v1/files/upload)
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("user", ctx.user);

  const r = await fetch(`${DIFY_BASE_URL}/v1/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.key}` },
    body: fd,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_upload_error", status: r.status, body: text.slice(0, 300) },
      { status: 502 },
    );
  }
  const j = await r.json();
  return NextResponse.json({
    id: j.id,
    name: j.name,
    size: j.size,
    extension: j.extension,
    mime_type: j.mime_type,
  });
}
