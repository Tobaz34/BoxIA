/**
 * Extraction texte de documents (PDF, DOCX, XLSX, TXT, MD) avant envoi LLM.
 *
 * Pourquoi côté Next.js (et pas côté Dify Knowledge Dataset) :
 *   - Garde Dify simple (chat-messages text-only, pas besoin de RAG par app)
 *   - Permet de pré-filtrer les contenus sensibles (PII)
 *   - Permet de capper le payload (éviter context overflow qwen3:14b ≤ 32k)
 *   - Permet de logger ce qui est passé au LLM (audit RGPD)
 *
 * Le texte extrait est inséré côté UI (Chat.tsx) en préfixe de la query
 * sous la balise --- CONTENU FICHIER nom.ext --- … --- FIN ---
 *
 * Cf. tests/benchmark-multimodal/proposed-fixes/BUG-023-doc-extraction.md
 */
// pdf-parse v1.x (≥1.1.4) — pure-JS, pas de polyfill DOM nécessaire (à la
// différence de v2 qui pull pdfjs-dist + DOMMatrix/Canvas → incompatible
// Next.js serverless). On importe le main qui prend un Buffer et retourne
// {text, numpages, info}.
//
// Note : index.js de pdf-parse v1 essaie de lire un PDF de test au require
// (./test/data/05-versions-space.pdf). Dans un container Docker minimal
// ce fichier existe — mais on cible directement lib/pdf-parse.js pour
// éviter cet effet de bord et le require dynamique.
// @ts-expect-error pdf-parse v1 ne fournit pas de typings pour le sous-path
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

interface PdfParseResult {
  text: string;
  numpages: number;
  info?: Record<string, unknown>;
}

export type ExtractResult =
  | { ok: true; text: string; pages?: number }
  | { ok: false; reason: string };

/** Cap conservateur : ~20k tokens text, safe pour qwen3:14b 32k context window. */
const MAX_CHARS = 80_000;

export async function extractDocument(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ExtractResult> {
  try {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isPdf = mime === "application/pdf" || ext === "pdf";
    const isDocx =
      mime.includes("wordprocessingml") || ext === "docx";
    const isXlsx =
      mime.includes("spreadsheetml") ||
      mime === "application/vnd.ms-excel" ||
      ext === "xlsx" ||
      ext === "xls" ||
      ext === "csv";
    const isPlain =
      mime === "text/plain" ||
      mime === "text/markdown" ||
      mime === "text/csv" ||
      ext === "txt" ||
      ext === "md";

    if (isPdf) {
      // pdf-parse v1 : signature simple (buffer) → { text, numpages, info }
      const r = (await pdfParse(buf)) as PdfParseResult;
      const text = (r.text || "").trim();
      if (!text) return { ok: false, reason: "pdf_no_text_layer" };
      return {
        ok: true,
        text: text.slice(0, MAX_CHARS),
        pages: r.numpages,
      };
    }
    if (isDocx) {
      const r = await mammoth.extractRawText({ buffer: buf });
      const text = (r.value || "").trim();
      if (!text) return { ok: false, reason: "docx_empty" };
      return { ok: true, text: text.slice(0, MAX_CHARS) };
    }
    if (isXlsx) {
      const wb = XLSX.read(buf, { type: "buffer" });
      const parts: string[] = [];
      for (const sheet of wb.SheetNames) {
        parts.push(`== sheet: ${sheet} ==`);
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
        parts.push(csv);
      }
      const text = parts.join("\n").trim();
      if (!text) return { ok: false, reason: "xlsx_empty" };
      return { ok: true, text: text.slice(0, MAX_CHARS) };
    }
    if (isPlain) {
      const text = buf.toString("utf8").trim();
      if (!text) return { ok: false, reason: "plain_empty" };
      return { ok: true, text: text.slice(0, MAX_CHARS) };
    }
    return { ok: false, reason: "unsupported_for_extraction" };
  } catch (e) {
    return {
      ok: false,
      reason: "extraction_error:" + String(e).slice(0, 100),
    };
  }
}
