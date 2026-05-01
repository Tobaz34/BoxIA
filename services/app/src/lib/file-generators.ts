/**
 * Générateurs de fichiers à partir de contenus markdown ou texte brut.
 *
 * L'agent IA émet un bloc dans sa réponse :
 *
 *   [FILE:nom.ext]
 *   ...contenu markdown ou texte...
 *   [/FILE]
 *
 * Le serveur détecte le bloc, identifie le type via l'extension du nom de
 * fichier, et appelle la bonne fonction de génération :
 *
 *   .docx           → markdownToDocx()
 *   .xlsx           → markdownToXlsx()  (parse les tables markdown)
 *   .pdf            → markdownToPdf()   (PDFKit, layout simple)
 *   .ps1 .sh .py    → buildScript()     (texte brut + shebang)
 *   .csv .json .md  → buildText()       (passthrough)
 *
 * Dans tous les cas, retourne un { buffer, mime, filename } à servir au
 * client via /api/files/[id]/download.
 */
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  BorderStyle,
} from "docx";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { marked } from "marked";

export interface GeneratedFile {
  buffer: Buffer;
  mime: string;
  filename: string;
}

/** MIME type d'un fichier d'après son extension (subset utile). */
const MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  ps1: "text/x-powershell",
  sh: "text/x-shellscript",
  py: "text/x-python",
  js: "application/javascript",
  ts: "application/typescript",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
};

/** Retourne le mime d'un nom de fichier. */
export function mimeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** Sanitise un nom de fichier pour éviter les path-traversal. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "fichier";
  return base.replace(/[^a-zA-Z0-9._\- ]/g, "_").slice(0, 100) || "fichier";
}

// =============================================================================
// Helper : extraire les tables markdown en arrays 2D
// =============================================================================

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  /** Position dans le markdown source (lignes inclusives). */
  startLine: number;
  endLine: number;
  /** Titre de section (le H1/H2 le plus proche au-dessus, si présent). */
  sectionTitle?: string;
}

/** Parse les tables markdown du texte. Retourne aussi les positions pour
 *  permettre au caller de connaître la structure. */
export function extractMarkdownTables(md: string): MarkdownTable[] {
  const lines = md.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let i = 0;
  let lastSectionTitle: string | undefined;

  while (i < lines.length) {
    const line = lines[i].trim();
    // Suivre les titres pour les nommer côté Excel
    const h = line.match(/^#+\s+(.+)$/);
    if (h) lastSectionTitle = h[1].trim();

    // Détection d'une table markdown : ligne avec | non vide,
    // ligne suivante avec --- séparateurs.
    if (line.startsWith("|") && i + 1 < lines.length
        && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const startLine = i;
      const headers = splitMdRow(line);
      i += 2; // skip header + sep
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitMdRow(lines[i].trim()));
        i++;
      }
      tables.push({
        headers, rows,
        startLine, endLine: i - 1,
        sectionTitle: lastSectionTitle,
      });
      continue;
    }
    i++;
  }
  return tables;
}

function splitMdRow(line: string): string[] {
  // |  a  |  b  |  c  | → ["a", "b", "c"]
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

// =============================================================================
// 1) DOCX — markdown → Word
// =============================================================================

/** Convertit un markdown en document Word .docx (paragraphes + headings + tables). */
export async function markdownToDocx(md: string, title?: string): Promise<Buffer> {
  const tokens = marked.lexer(md);
  const children: (Paragraph | Table)[] = [];

  if (title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: 36 })],
      spacing: { after: 400 },
    }));
  }

  for (const tok of tokens) {
    if (tok.type === "heading") {
      const lvl = (tok as { depth: number }).depth;
      const heading =
        lvl === 1 ? HeadingLevel.HEADING_1
        : lvl === 2 ? HeadingLevel.HEADING_2
        : lvl === 3 ? HeadingLevel.HEADING_3
        : lvl === 4 ? HeadingLevel.HEADING_4
        : lvl === 5 ? HeadingLevel.HEADING_5
        : HeadingLevel.HEADING_6;
      children.push(new Paragraph({
        heading,
        children: [new TextRun({ text: (tok as { text: string }).text, bold: true })],
        spacing: { before: 200, after: 100 },
      }));
    } else if (tok.type === "paragraph") {
      const txt = (tok as { text: string }).text;
      children.push(new Paragraph({
        children: parseInlineFormats(txt),
        spacing: { after: 100 },
      }));
    } else if (tok.type === "list") {
      for (const item of (tok as { items: Array<{ text: string }> }).items) {
        children.push(new Paragraph({
          bullet: { level: 0 },
          children: parseInlineFormats(item.text),
        }));
      }
    } else if (tok.type === "code") {
      children.push(new Paragraph({
        children: [new TextRun({
          text: (tok as { text: string }).text,
          font: "Consolas", size: 18,
        })],
        spacing: { before: 100, after: 100 },
      }));
    } else if (tok.type === "table") {
      const tk = tok as { header: Array<{ text: string }>; rows: Array<Array<{ text: string }>> };
      children.push(buildDocxTable(
        tk.header.map((c) => c.text),
        tk.rows.map((row) => row.map((c) => c.text)),
      ));
      children.push(new Paragraph({ text: "" }));   // spacer
    } else if (tok.type === "blockquote") {
      children.push(new Paragraph({
        children: [new TextRun({
          text: (tok as { text: string }).text,
          italics: true, color: "666666",
        })],
        indent: { left: 400 },
      }));
    } else if (tok.type === "hr") {
      children.push(new Paragraph({
        children: [new TextRun("─".repeat(50))],
        alignment: AlignmentType.CENTER,
      }));
    }
  }

  const doc = new Document({
    creator: "AI Box",
    title: title || "Document généré",
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function parseInlineFormats(text: string): TextRun[] {
  // Gestion minimaliste de **gras** et *italique*.
  // On split sur les marqueurs sans tout reparser.
  const out: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(new TextRun(text.slice(last, m.index)));
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    } else if (tok.startsWith("`")) {
      out.push(new TextRun({ text: tok.slice(1, -1), font: "Consolas" }));
    } else if (tok.startsWith("*")) {
      out.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    } else {
      out.push(new TextRun(tok));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)));
  if (out.length === 0) out.push(new TextRun(text));
  return out;
}

function buildDocxTable(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    children: headers.map((h) => new TableCell({
      width: { size: Math.floor(100 / headers.length), type: WidthType.PERCENTAGE },
      shading: { fill: "DDEEFF" },
      children: [new Paragraph({
        children: [new TextRun({ text: h, bold: true })],
        alignment: AlignmentType.CENTER,
      })],
    })),
    tableHeader: true,
  });
  const bodyRows = rows.map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      width: { size: Math.floor(100 / headers.length), type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: parseInlineFormats(cell) })],
    })),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      left:   { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      right:  { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" },
      insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" },
    },
  });
}

// =============================================================================
// 2) XLSX — markdown → Excel (1 sheet par table markdown trouvée)
// =============================================================================

/** Convertit un markdown contenant des tables en XLSX.
 *  - Si plusieurs tables : 1 sheet par table, nommée d'après le dernier H#
 *  - Si aucune table : 1 sheet "Notes" avec le contenu en lignes texte. */
export async function markdownToXlsx(md: string, title?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI Box";
  wb.created = new Date();

  const tables = extractMarkdownTables(md);

  if (tables.length === 0) {
    // Pas de table : sheet texte simple
    const ws = wb.addWorksheet(sanitizeSheetName(title || "Document"));
    md.split(/\r?\n/).forEach((line) => ws.addRow([line]));
    ws.getColumn(1).width = 100;
  } else {
    const usedNames = new Set<string>();
    tables.forEach((t, idx) => {
      let baseName = sanitizeSheetName(t.sectionTitle || title || `Table ${idx + 1}`);
      let name = baseName;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = sanitizeSheetName(`${baseName} (${suffix})`);
        suffix++;
      }
      usedNames.add(name);
      const ws = wb.addWorksheet(name);

      // Header
      ws.addRow(t.headers);
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      headerRow.fill = {
        type: "pattern", pattern: "solid",
        fgColor: { argb: "FF2563EB" },
      };
      headerRow.alignment = { horizontal: "center", vertical: "middle" };

      // Body
      t.rows.forEach((row) => {
        // Convertit les valeurs numériques (ex: "1234.56", "1 234,56 €") en number
        const typed = row.map((cell) => parseSmartValue(cell));
        ws.addRow(typed);
      });

      // Auto width simple : longueur max par colonne
      t.headers.forEach((_, ci) => {
        let maxLen = (t.headers[ci] || "").length;
        t.rows.forEach((row) => {
          const v = String(row[ci] ?? "");
          if (v.length > maxLen) maxLen = v.length;
        });
        ws.getColumn(ci + 1).width = Math.min(60, Math.max(10, maxLen + 2));
      });

      // Bordures fines sur toutes les cellules data
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          cell.border = {
            top:    { style: "thin", color: { argb: "FFCCCCCC" } },
            left:   { style: "thin", color: { argb: "FFCCCCCC" } },
            bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
            right:  { style: "thin", color: { argb: "FFCCCCCC" } },
          };
        });
      });
    });
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}

function sanitizeSheetName(raw: string): string {
  // Excel : max 31 chars, pas de [ ] : * ? / \
  return raw.replace(/[[\]:*?/\\]/g, "_").slice(0, 31).trim() || "Sheet";
}

/** Tente de convertir une string en nombre/date pour qu'Excel reconnaisse le type.
 *  Sinon retourne la string telle quelle. */
function parseSmartValue(raw: string): string | number {
  if (!raw) return "";
  // Suppression espaces fines, € $, %, etc.
  const cleaned = raw
    .replace(/ | /g, "")  // espaces insécables
    .replace(/\s/g, "")
    .replace(/€|\$|£/g, "")
    .replace(",", ".");
  if (/^-?\d+(\.\d+)?%?$/.test(cleaned)) {
    const isPct = cleaned.endsWith("%");
    const num = parseFloat(isPct ? cleaned.slice(0, -1) : cleaned);
    if (Number.isFinite(num)) return isPct ? num / 100 : num;
  }
  return raw;
}

// =============================================================================
// 3) PDF — markdown simplifié → PDF (PDFKit pure JS, pas de chromium)
// =============================================================================

export async function markdownToPdf(md: string, title?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: { Title: title || "Document AI Box", Creator: "AI Box" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (title) {
      doc.fontSize(20).font("Helvetica-Bold").text(title, { align: "center" });
      doc.moveDown();
    }

    const tokens = marked.lexer(md);
    for (const tok of tokens) {
      if (tok.type === "heading") {
        const lvl = (tok as { depth: number }).depth;
        const sizeMap: Record<number, number> = { 1: 18, 2: 16, 3: 14, 4: 13, 5: 12, 6: 11 };
        doc.moveDown(0.5);
        doc.fontSize(sizeMap[lvl] || 12).font("Helvetica-Bold")
           .text((tok as { text: string }).text);
        doc.moveDown(0.3);
      } else if (tok.type === "paragraph") {
        doc.fontSize(11).font("Helvetica")
           .text(stripInline((tok as { text: string }).text));
        doc.moveDown(0.4);
      } else if (tok.type === "list") {
        doc.fontSize(11).font("Helvetica");
        for (const item of (tok as { items: Array<{ text: string }> }).items) {
          doc.text(`• ${stripInline(item.text)}`, { indent: 14 });
        }
        doc.moveDown(0.3);
      } else if (tok.type === "code") {
        doc.fontSize(9).font("Courier")
           .fillColor("#444")
           .text((tok as { text: string }).text, { indent: 14 });
        doc.fillColor("#000");
        doc.moveDown(0.3);
      } else if (tok.type === "table") {
        renderPdfTable(doc, tok as { header: Array<{ text: string }>; rows: Array<Array<{ text: string }>> });
      } else if (tok.type === "blockquote") {
        doc.fontSize(11).font("Helvetica-Oblique").fillColor("#666")
           .text(stripInline((tok as { text: string }).text), { indent: 14 });
        doc.fillColor("#000");
        doc.moveDown(0.3);
      } else if (tok.type === "hr") {
        const y = doc.y + 4;
        doc.strokeColor("#bbb").lineWidth(0.5)
           .moveTo(doc.page.margins.left, y)
           .lineTo(doc.page.width - doc.page.margins.right, y).stroke();
        doc.moveDown(0.6);
      }
    }
    doc.end();
  });
}

function stripInline(text: string): string {
  // Retire les balises markdown inline pour le PDF (PDFKit ne supporte pas
  // gras/italique sans changement de font à la main)
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function renderPdfTable(
  doc: PDFKit.PDFDocument,
  tok: { header: Array<{ text: string }>; rows: Array<Array<{ text: string }>> },
): void {
  const headers = tok.header.map((c) => stripInline(c.text));
  const rows = tok.rows.map((r) => r.map((c) => stripInline(c.text)));
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colW = pageWidth / headers.length;
  const startX = doc.page.margins.left;
  let y = doc.y;

  // Header
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#fff");
  doc.rect(startX, y, pageWidth, 20).fill("#2563eb");
  doc.fillColor("#fff");
  headers.forEach((h, ci) => {
    doc.text(h, startX + ci * colW + 4, y + 6, {
      width: colW - 8, ellipsis: true,
    });
  });
  y += 20;
  doc.fillColor("#000").font("Helvetica").fontSize(10);

  // Body
  rows.forEach((row, ri) => {
    if (y + 18 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (ri % 2 === 0) {
      doc.rect(startX, y, pageWidth, 18).fill("#f5f7fa");
      doc.fillColor("#000");
    }
    row.forEach((cell, ci) => {
      doc.text(cell, startX + ci * colW + 4, y + 4, {
        width: colW - 8, ellipsis: true,
      });
    });
    y += 18;
  });
  doc.y = y + 8;
}

// =============================================================================
// 4) Scripts (PowerShell, Bash, Python) — texte brut + shebang/commentaire
// =============================================================================

const SHEBANGS: Record<string, string> = {
  ps1: "# AI Box — script PowerShell généré\n# Usage : .\\nom.ps1\n# ⚠ Vérifier le contenu avant exécution.\n",
  sh:  "#!/usr/bin/env bash\n# AI Box — script Bash généré\n# ⚠ Vérifier le contenu avant exécution.\n\nset -euo pipefail\n",
  py:  "#!/usr/bin/env python3\n# AI Box — script Python généré\n# ⚠ Vérifier le contenu avant exécution.\n",
};

/** Construit un script texte. Si le contenu contient déjà un shebang/header,
 *  on ne le double pas. */
export function buildScript(content: string, ext: string): Buffer {
  const lower = ext.toLowerCase();
  const trimmed = content.trim();
  const header = SHEBANGS[lower];
  if (header && !trimmed.startsWith("#") && !trimmed.startsWith("<#")) {
    return Buffer.from(header + "\n" + trimmed + "\n", "utf8");
  }
  return Buffer.from(trimmed + "\n", "utf8");
}

/** Texte brut (csv, json, md, txt) : passthrough avec normalisation des
 *  fins de ligne en \r\n pour Windows. */
export function buildText(content: string, ext: string): Buffer {
  const lower = ext.toLowerCase();
  // CSV : forcer CRLF (RFC 4180), JSON/MD : LF
  const eol = lower === "csv" ? "\r\n" : "\n";
  const normalized = content.replace(/\r?\n/g, eol);
  return Buffer.from(normalized, "utf8");
}

// =============================================================================
// API publique : route un nom de fichier vers le bon générateur
// =============================================================================

export async function generateFromContent(
  filename: string,
  rawContent: string,
): Promise<GeneratedFile> {
  const ext = filename.split(".").pop()?.toLowerCase() || "txt";
  const safe = sanitizeFilename(filename);
  const mime = mimeForFilename(safe);

  let buffer: Buffer;
  switch (ext) {
    case "docx":
      buffer = await markdownToDocx(rawContent, basenameWithoutExt(safe));
      break;
    case "xlsx":
      buffer = await markdownToXlsx(rawContent, basenameWithoutExt(safe));
      break;
    case "pdf":
      buffer = await markdownToPdf(rawContent, basenameWithoutExt(safe));
      break;
    case "ps1":
    case "sh":
    case "py":
      buffer = buildScript(rawContent, ext);
      break;
    default:
      buffer = buildText(rawContent, ext);
  }
  return { buffer, mime, filename: safe };
}

function basenameWithoutExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}
