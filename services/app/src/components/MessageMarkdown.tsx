"use client";

/**
 * Rendu Markdown pour les messages assistant.
 *
 * - GFM (tables, strikethrough, task lists)
 * - Code blocks avec syntax highlighting (highlight.js via rehype-highlight)
 * - Bouton "Copier" sur chaque code block
 * - Liens en target="_blank" + rel="noopener noreferrer"
 *
 * Le thème highlight.js est importé dans globals.css.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { useState, type ComponentProps } from "react";

function CodeBlockHeader({ lang, raw }: { lang: string; raw: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted bg-muted/10 border-b border-border">
      <span>{lang}</span>
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
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
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
            const lang = (codeProps.className || "")
              .replace(/^language-/, "")
              .replace(/\s.*$/, "") || "text";
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
