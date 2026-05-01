"use client";

/**
 * Rendu Markdown pour les messages assistant.
 *
 * - GFM (tables, strikethrough, task lists)
 * - Math (formules LaTeX inline `$...$` et display `$$...$$`) via KaTeX
 * - Code blocks avec syntax highlighting (highlight.js via rehype-highlight)
 * - Bouton "Copier" sur chaque code block
 * - Liens en target="_blank" + rel="noopener noreferrer"
 *
 * Les thèmes highlight.js et KaTeX sont importés dans globals.css.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import {
  Check, Copy, Download, FileText, FileSpreadsheet, FileType,
  FileCode, File as FileIcon, Loader2,
} from "lucide-react";
import { useMemo, useState, type ComponentProps } from "react";

/** Map langage → extension de fichier proposée pour "Save as".
 *  null = pas de bouton save (langues non scriptables comme markdown ou plain text). */
const SAVE_EXT_BY_LANG: Record<string, string | null> = {
  powershell: "ps1",
  ps1: "ps1",
  ps: "ps1",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  python: "py",
  py: "py",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  json: "json",
  yaml: "yml",
  yml: "yml",
  xml: "xml",
  html: "html",
  css: "css",
  sql: "sql",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  cs: "cs",
  text: null,
  markdown: null,
  md: null,
};

function CodeBlockHeader({ lang, raw }: { lang: string; raw: string }) {
  const [copied, setCopied] = useState(false);
  const saveExt = SAVE_EXT_BY_LANG[lang.toLowerCase()];

  function handleSave() {
    if (!saveExt) return;
    const isDockerfile = saveExt === "Dockerfile";
    const filename = isDockerfile
      ? "Dockerfile"
      : `script-${Date.now().toString(36)}.${saveExt}`;
    const mime = saveExt === "json" ? "application/json"
      : saveExt === "html" ? "text/html"
      : "text/plain";
    const blob = new Blob([raw], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted bg-muted/10 border-b border-border">
      <span>{lang}</span>
      <div className="flex gap-1">
        {saveExt && (
          <button
            onClick={handleSave}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted/30 transition-default"
            title={`Télécharger en .${saveExt === "Dockerfile" ? "" : saveExt}`}
          >
            <Download size={12} />
            .{saveExt}
          </button>
        )}
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(raw);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch { /* noop */ }
          }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted/30 transition-default"
          title="Copier"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copié" : "Copier"}
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// Détection et rendu des fichiers générés par l'agent
// =========================================================================
//
// Le serveur insère dans la sortie LLM un marker
//    {{file:UUID:filename:size:mime}}
// à chaque fois qu'un bloc [FILE:...]…[/FILE] a été détecté et matérialisé
// (cf. lib/chat-stream-files.ts). On split le content en segments texte +
// segments fichier pour pouvoir rendre des chips téléchargeables au bon
// endroit du flux.

interface FileToken {
  type: "file";
  id: string;
  name: string;
  size: number;
  mime: string;
}
interface TextToken {
  type: "text";
  value: string;
}
type Segment = FileToken | TextToken;

function parseFileMarkers(content: string): Segment[] {
  const re = /\{\{file:([0-9a-f-]+):([^:]+):(\d+):([^}]+)\}\}/g;
  const out: Segment[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIdx) {
      out.push({ type: "text", value: content.slice(lastIdx, m.index) });
    }
    out.push({
      type: "file",
      id: m[1],
      name: decodeURIComponent(m[2]),
      size: parseInt(m[3], 10),
      mime: m[4],
    });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < content.length) {
    out.push({ type: "text", value: content.slice(lastIdx) });
  }
  return out.length > 0 ? out : [{ type: "text", value: content }];
}

function iconForExt(name: string): typeof FileIcon {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "docx") return FileType;
  if (ext === "xlsx" || ext === "csv") return FileSpreadsheet;
  if (ext === "pdf") return FileText;
  if (["ps1", "sh", "py", "js", "ts", "json", "yaml", "yml", "xml", "html"].includes(ext)) {
    return FileCode;
  }
  return FileIcon;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function DownloadChip({ id, name, size }: FileToken) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = iconForExt(name);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const r = await fetch(`/api/files/${id}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      className={
        "my-2 inline-flex items-center gap-3 px-3 py-2 rounded-md border " +
        "border-border bg-muted/10 hover:bg-muted/20 transition-default group " +
        "disabled:opacity-60 max-w-full"
      }
      title={`Télécharger ${name}`}
    >
      <div className="w-9 h-9 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
        <Icon size={18} />
      </div>
      <div className="text-left min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{name}</div>
        <div className="text-[11px] text-muted">
          {error ? <span className="text-red-400">⚠ {error}</span> : fmtSize(size)}
        </div>
      </div>
      <div className="shrink-0">
        {downloading
          ? <Loader2 size={16} className="animate-spin text-muted" />
          : <Download size={16} className="text-muted group-hover:text-primary transition-default" />}
      </div>
    </button>
  );
}

/** Extrait le texte brut d'un noeud react-markdown (pour le bouton Copier).
 *  Avec rehype-highlight les enfants deviennent des spans imbriqués → on
 *  walk récursivement pour reconstituer le texte original. */
function extractText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

export function MessageMarkdown({ content }: { content: string }) {
  const segments = useMemo(() => parseFileMarkers(content), [content]);
  return (
    <div className="prose-chat">
      {segments.map((seg, i) =>
        seg.type === "file"
          ? <DownloadChip key={`f-${seg.id}-${i}`} {...seg} />
          : <MarkdownPart key={`t-${i}`} content={seg.value} />,
      )}
    </div>
  );
}

function MarkdownPart({ content }: { content: string }) {
  return (
    <div>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          rehypeKatex,
        ]}
        components={{
          // pre = wrapper autour du code block. On lui ajoute juste un header
          // (langue + bouton copier). Le contenu est rendu par le composant
          // <code> ci-dessous (qui reçoit déjà les <span> highlightés).
          pre: ({ children, ...rest }: ComponentProps<"pre">) => {
            // Trouve le <code> enfant pour extraire className (langue) + texte brut
            const codeChild = Array.isArray(children)
              ? children.find(
                  (c) => c && typeof c === "object" && "type" in c && c.type === "code",
                )
              : children;
            const codeProps =
              codeChild && typeof codeChild === "object" && "props" in codeChild
                ? (codeChild as { props: { className?: string; children?: unknown } }).props
                : { className: "", children: "" };
            // className peut contenir plusieurs classes ("hljs language-python")
            // → on cherche celle qui commence par "language-"
            const langClass = (codeProps.className || "")
              .split(/\s+/)
              .find((c) => c.startsWith("language-"));
            const lang = langClass ? langClass.replace("language-", "") : "text";
            const raw = extractText(codeProps.children).replace(/\n$/, "");
            return (
              <div className="relative my-3 rounded-md overflow-hidden border border-border bg-background/60">
                <CodeBlockHeader lang={lang} raw={raw} />
                <pre className="overflow-x-auto p-3 text-xs leading-relaxed" {...rest}>
                  {children}
                </pre>
              </div>
            );
          },
          // Code inline (`foo`) — pas de className=language-* (sinon c'est un block géré par <pre>).
          code: ({ children, className, ...rest }: ComponentProps<"code">) => {
            if (className) {
              // Block fenced — laisse rehype-highlight rendre les <span> enfants
              return <code className={className} {...rest}>{children}</code>;
            }
            return (
              <code
                className="px-1 py-0.5 rounded bg-muted/30 text-[0.9em] font-mono"
                {...rest}
              >
                {children}
              </code>
            );
          },
          // Liens externes en nouvel onglet
          a: ({ children, href, ...rest }: ComponentProps<"a">) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
              {...rest}
            >
              {children}
            </a>
          ),
          table: ({ children, ...rest }: ComponentProps<"table">) => (
            <div className="my-3 overflow-x-auto">
              <table
                className="w-full text-xs border border-border rounded"
                {...rest}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...rest }: ComponentProps<"th">) => (
            <th
              className="px-2 py-1 text-left bg-muted/20 border-b border-border font-medium"
              {...rest}
            >
              {children}
            </th>
          ),
          td: ({ children, ...rest }: ComponentProps<"td">) => (
            <td className="px-2 py-1 border-b border-border/50" {...rest}>
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
