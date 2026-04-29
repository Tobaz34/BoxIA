/**
 * GET  /api/documents              — liste les documents indexés.
 * POST /api/documents (multipart)  — upload un fichier (PDF, .txt, .md, .docx, .csv, .xlsx).
 *
 * Wrap autour du Dify Service Dataset API.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireKbContext, kbFetch, DIFY_BASE_URL, DIFY_KB_API_KEY,
         DIFY_DEFAULT_DATASET_ID } from "@/lib/dify-kb";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await requireKbContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") || "50";
  const page = searchParams.get("page") || "1";
  const keyword = searchParams.get("keyword") || "";

  const params = new URLSearchParams({ limit, page });
  if (keyword) params.set("keyword", keyword);

  const r = await kbFetch(
    `/v1/datasets/${ctx.datasetId}/documents?${params.toString()}`,
    { key: ctx.key },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "kb_error", status: r.status, body: text.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json(await r.json());
}

export async function POST(req: NextRequest) {
  const ctx = await requireKbContext();
  if (ctx instanceof NextResponse) return ctx;

  // Lit le multipart côté Next.js, puis ré-encode pour Dify (qui attend
  // un champ `data` JSON + un champ `file` binaire).
  const incoming = await req.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }

  const fd = new FormData();
  // Paramètres d'indexation : on prend les défauts Dify pour la KB.
  fd.append(
    "data",
    JSON.stringify({
      indexing_technique: "high_quality",
      process_rule: { mode: "automatic" },
    }),
  );
  fd.append("file", file, file.name);

  // Note : on ne peut pas utiliser kbFetch ici car il faut SUPPRIMER
  // l'header Content-Type (fetch met le bon avec boundary tout seul si on
  // passe FormData directement). On appelle fetch en direct.
  const r = await fetch(
    `${DIFY_BASE_URL}/v1/datasets/${ctx.datasetId}/document/create-by-file`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.key}` },
      body: fd,
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "kb_upload_error", status: r.status, body: text.slice(0, 300) },
      { status: 502 },
    );
  }
  return NextResponse.json(await r.json());
}

// Reference imports to silence unused-warnings (DIFY_BASE_URL etc. utilisés)
void kbFetch;
void DIFY_KB_API_KEY;
void DIFY_DEFAULT_DATASET_ID;
