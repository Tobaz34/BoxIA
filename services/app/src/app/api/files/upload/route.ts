/**
 * POST /api/files/upload (multipart) — upload un fichier (image OU document)
 * à Dify pour qu'on puisse ensuite l'inclure dans une chat-messages.
 *
 * body: FormData avec un champ "file" + champ "agent" (slug)
 *
 * Retourne le file_id Dify + un champ `kind` ("image" | "document"),
 * à passer au prochain /api/chat dans :
 *   files: [{ type: "image"|"document", transfer_method: "local_file",
 *             upload_file_id: <id> }]
 *
 * Limites :
 *   - Images : 8 MB max (jpg, png, webp, gif)
 *   - Documents : 20 MB max (pdf, txt, md, docx, doc, csv, html)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, DIFY_BASE_URL } from "@/lib/dify";
import { extractDocument, type ExtractResult } from "@/lib/extract-doc";

export const dynamic = "force-dynamic";
export const config = { api: { bodyParser: false } };

const IMAGE_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc (legacy)
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);
// Fallback par extension si le navigateur ne reconnaît pas le mime
const EXT_TO_KIND: Record<string, "image" | "document"> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image",
  pdf: "document", txt: "document", md: "document", csv: "document",
  html: "document", htm: "document",
  doc: "document", docx: "document",
  xls: "document", xlsx: "document",
  ppt: "document", pptx: "document",
};

const IMG_MAX = 8 * 1024 * 1024;     // 8 MB
const DOC_MAX = 20 * 1024 * 1024;    // 20 MB

function classify(file: File): "image" | "document" | null {
  if (IMAGE_MIMES.has(file.type)) return "image";
  if (DOCUMENT_MIMES.has(file.type)) return "document";
  // Fallback sur extension
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return EXT_TO_KIND[ext] || null;
}

export async function POST(req: NextRequest) {
  const incoming = await req.formData();
  const agent = incoming.get("agent") as string | null;
  const file = incoming.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  const kind = classify(file);
  if (!kind) {
    return NextResponse.json(
      { error: "unsupported_type",
        message: `Type non supporté : ${file.type || file.name}. ` +
                 `Formats acceptés : images (JPG, PNG, WebP) ou documents ` +
                 `(PDF, TXT, MD, DOCX, XLSX, HTML, CSV).` },
      { status: 415 },
    );
  }
  const limit = kind === "image" ? IMG_MAX : DOC_MAX;
  if (file.size > limit) {
    const limitMB = Math.round(limit / 1024 / 1024);
    return NextResponse.json(
      { error: "too_large",
        message: `Fichier trop grand (max ${limitMB} Mo pour ${kind === "image" ? "une image" : "un document"}).` },
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
      { error: "dify_upload_error", status: r.status,
        body: text.slice(0, 300) },
      { status: 502 },
    );
  }
  const j = await r.json();

  // BUG-023 — Extraction texte préventive pour les documents.
  // Dify n'extrait pas le contenu des PDF/DOCX/XLSX par défaut quand on
  // n'a ni Knowledge Dataset RAG ni nœud Document Extractor dans un
  // workflow. Sans cette extraction côté Next.js, le LLM reçoit juste
  // l'upload_file_id sans contenu utile et hallucine.
  // Le texte extrait est renvoyé au client qui le concatène en préfixe
  // de la query au prochain /api/chat (cf. components/Chat.tsx).
  let extracted: ExtractResult | null = null;
  if (kind === "document") {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      extracted = await extractDocument(buf, file.type, file.name);
    } catch (e) {
      extracted = { ok: false, reason: "extraction_failed:" + String(e).slice(0, 100) };
    }
  }

  return NextResponse.json({
    id: j.id,
    kind,                    // ← à passer dans `files[].type` au /api/chat
    name: j.name,
    size: j.size,
    extension: j.extension,
    mime_type: j.mime_type,
    extracted_text: extracted?.ok ? extracted.text : null,
    extracted_pages: extracted?.ok ? extracted.pages : null,
    extraction_error: extracted && !extracted.ok ? extracted.reason : null,
  });
}
