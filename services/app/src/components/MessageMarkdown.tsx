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
  Check, Copy, Eye, Download, Loader2, Brain, ChevronDown, ChevronRight,
  File as FileIcon, FileText, FileType, FileSpreadsheet, FileCode,
} from "lucide-react";
import { useMemo, useState, type ComponentProps } from "react";
import { ArtifactPanel } from "./ArtifactPanel";
import {
  artifactKindFromLang,
  deriveArtifactTitle,
  type ArtifactKind,
} from "@/lib/artifacts";

function CodeBlockHeader({
  lang,
  raw,
  artifactKind,
  onOpenArtifact,
}: {
  lang: string;
  raw: string;
  artifactKind: ArtifactKind | null;
  onOpenArtifact?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // BUG-020 (Save as .ext) : ancien code orphan retiré — la constante
  // SAVE_EXT_BY_LANG n'a jamais été commit. Le bouton "Save as" sera
  // ré-ajouté dans une session future si BUG-020 est priorisé.

  return (
    <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted bg-muted/10 border-b border-border">
      <span>{lang}</span>
      <div className="flex items-center gap-1.5">
        {artifactKind && onOpenArtifact && (
          <button
            onClick={onOpenArtifact}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-primary hover:bg-primary/10 transition-default"
            title="Voir le rendu dans un panneau"
          >
            <Eye size={12} />
            Voir
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
interface ThinkToken {
  type: "think";
  /** Contenu brut du bloc raisonnement (sans les balises). */
  value: string;
  /** True si le bloc est encore en cours de stream (`<think>` ouvert
   *  mais `</think>` pas encore reçu). */
  open: boolean;
}
type Segment = FileToken | TextToken | ThinkToken;

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

/** Extrait les blocs `<think>...</think>` (et `<thinking>...</thinking>`)
 *  comme segments distincts. Le strip-think côté serveur (lib/strip-think.ts)
 *  peut rater certains streams (différents providers, formats…) — on
 *  fait donc un fallback côté UI : si le contenu contient ces balises,
 *  on les rend en bloc collapsible plutôt qu'en texte brut.
 *
 *  Streaming : si `<think>` est ouvert mais `</think>` pas encore reçu,
 *  on émet un ThinkToken `open=true` (le composant affiche "réfléchit
 *  en cours…" plutôt que le contenu).
 */
function parseThinkBlocks(content: string): Array<{ type: "think" | "normal"; value: string; open?: boolean }> {
  const out: Array<{ type: "think" | "normal"; value: string; open?: boolean }> = [];
  const re = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIdx) {
      out.push({ type: "normal", value: content.slice(lastIdx, m.index) });
    }
    // Détecte si la balise fermante a été matchée (m[0] contient </think>)
    // ou si on a fini sur la fin de chaîne (= encore en stream).
    const closed = /<\/think(?:ing)?>/i.test(m[0]);
    out.push({ type: "think", value: m[1], open: !closed });
    lastIdx = m.index + m[0].length;
    // Si pas fermé, on stoppe : tout le reste est dans le think
    if (!closed) break;
  }
  if (lastIdx < content.length) {
    out.push({ type: "normal", value: content.slice(lastIdx) });
  }
  return out.length > 0 ? out : [{ type: "normal", value: content }];
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

/** Bloc de raisonnement modèle (qwen3 thinking, GPT o1, Claude extended-
 *  thinking, etc.) collapsible. Closed par défaut pour ne pas polluer
 *  l'UI ; un click révèle le raisonnement intégral. Si l'open prop=true,
 *  le bloc est en cours de streaming et on affiche un loader.
 */
function ThinkingBlock({ value, open: streaming }: { value: string; open?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // Estimation grossière : ~5 chars / mot
  const wordCount = useMemo(() => Math.round(value.trim().length / 5), [value]);

  return (
    <div className="my-2 rounded-md border border-muted/30 bg-muted/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:bg-muted/10 transition-default"
      >
        {streaming
          ? <Loader2 size={12} className="animate-spin shrink-0" />
          : <Brain size={12} className="shrink-0 opacity-70" />}
        <span className="font-medium">
          {streaming
            ? "Le modèle réfléchit…"
            : expanded
              ? "Masquer le raisonnement"
              : `Voir le raisonnement (~${wordCount} mots)`}
        </span>
        <span className="ml-auto">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 text-[11px] text-muted/80 whitespace-pre-wrap font-mono leading-relaxed border-t border-muted/20">
          {value.trim()}
        </div>
      )}
    </div>
  );
}

export function MessageMarkdown({ content }: { content: string }) {
  // 1. Split d'abord sur les blocs <think>...</think> (collapsible UI fallback
  //    quand strip-think côté serveur n'a pas attrapé).
  // 2. Sur chaque sous-bloc "normal", split sur les file markers
  //    {{file:UUID:nom:size:mime}} (BUG-006).
  const blocks = useMemo(() => parseThinkBlocks(content), [content]);

  return (
    <div className="prose-chat">
      {blocks.map((b, bi) => {
        if (b.type === "think") {
          return <ThinkingBlock key={`th-${bi}`} value={b.value} open={b.open} />;
        }
        const segments = parseFileMarkers(b.value);
        return (
          <div key={`n-${bi}`}>
            {segments.map((seg, i) =>
              seg.type === "file"
                ? <DownloadChip key={`f-${seg.id}-${i}`} {...seg} />
                : seg.type === "text"
                  ? <MarkdownPart key={`t-${i}`} content={seg.value} />
                  : null,
            )}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownPart({ content }: { content: string }) {
  // État du panneau Canvas/Artifact — un seul panneau ouvert à la fois
  // par segment de message rendu.
  const [artifact, setArtifact] = useState<{
    kind: ArtifactKind;
    code: string;
    title: string;
  } | null>(null);

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
          // (langue + bouton copier + bouton « Voir » si block rendable).
          // Le contenu est rendu par le composant <code> ci-dessous (qui
          // reçoit déjà les <span> highlightés).
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
            const artifactKind = artifactKindFromLang(lang);
            return (
              <div className="relative my-3 rounded-md overflow-hidden border border-border bg-background/60">
                <CodeBlockHeader
                  lang={lang}
                  raw={raw}
                  artifactKind={artifactKind}
                  onOpenArtifact={
                    artifactKind
                      ? () =>
                          setArtifact({
                            kind: artifactKind,
                            code: raw,
                            title: deriveArtifactTitle(artifactKind, raw),
                          })
                      : undefined
                  }
                />
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
      {artifact && (
        <ArtifactPanel
          open
          kind={artifact.kind}
          code={artifact.code}
          title={artifact.title}
          onClose={() => setArtifact(null)}
        />
      )}
    </div>
  );
}
