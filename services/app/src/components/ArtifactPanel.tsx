"use client";

/**
 * ArtifactPanel — drawer plein hauteur (côté droit) qui rend en preview
 * un block « rendable » (HTML, SVG, Mermaid) émis par l'assistant.
 *
 * Ouvert via le bouton « Voir » injecté dans MessageMarkdown sur les
 * code blocks dont le langage est html / svg / mermaid.
 *
 * Mermaid : on n'a pas la dépendance npm `mermaid` (trop lourde, ~600 KB).
 * On utilise le CDN officiel (esm.sh) chargé à la demande dans une iframe.
 */
import { useEffect, useRef } from "react";
import { X, Code2, Eye, Download } from "lucide-react";
import {
  basicSanitize,
  buildHtmlSrcDoc,
  type ArtifactKind,
} from "@/lib/artifacts";

interface Props {
  open: boolean;
  kind: ArtifactKind;
  code: string;
  title: string;
  onClose: () => void;
}

export function ArtifactPanel({ open, kind, code, title, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Mermaid : injecte un mini doc qui charge mermaid depuis esm.sh, puis
  // appelle .render() sur le code source. Tout est isolé dans l'iframe.
  useEffect(() => {
    if (!open || kind !== "mermaid" || !iframeRef.current) return;
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:16px;background:#fff;}</style>
</head><body>
<div id="container"></div>
<script type="module">
  try {
    const m = await import("https://esm.sh/mermaid@10");
    m.default.initialize({ startOnLoad: false, theme: "default" });
    const src = ${JSON.stringify(code)};
    const { svg } = await m.default.render("g", src);
    document.getElementById("container").innerHTML = svg;
  } catch (e) {
    document.body.innerHTML = '<pre style="color:#b91c1c;white-space:pre-wrap">Erreur Mermaid : '+(e?.message||e)+'</pre>';
  }
</script>
</body></html>`;
    iframeRef.current.srcdoc = html;
  }, [open, kind, code]);

  if (!open) return null;

  function downloadCode() {
    const ext = kind === "mermaid" ? "mmd" : kind;
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9-]/gi, "_").slice(0, 40)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`Artifact: ${title}`}
    >
      {/* Backdrop click-to-close */}
      <button
        className="flex-1 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Fermer le panneau"
      />
      {/* Drawer */}
      <div className="w-full max-w-3xl h-full bg-card border-l border-border flex flex-col shadow-2xl">
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Eye size={14} className="text-primary shrink-0" />
            <span className="font-medium text-sm truncate" title={title}>
              {title}
            </span>
            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted/30 text-muted shrink-0">
              {kind}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={downloadCode}
              className="p-1.5 rounded hover:bg-muted/20 text-muted"
              title="Télécharger le code"
            >
              <Download size={14} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-muted/20 text-muted"
              title="Fermer"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Preview : pleine hauteur */}
        <div className="flex-1 min-h-0 overflow-hidden bg-white dark:bg-neutral-100">
          {kind === "html" && (
            <iframe
              key={code.slice(0, 100)}
              srcDoc={buildHtmlSrcDoc(code)}
              sandbox="allow-scripts allow-forms allow-same-origin"
              className="w-full h-full border-0"
              title={title}
            />
          )}
          {kind === "svg" && (
            <div
              className="w-full h-full overflow-auto p-4 flex items-center justify-center"
              dangerouslySetInnerHTML={{ __html: basicSanitize(code) }}
            />
          )}
          {kind === "mermaid" && (
            <iframe
              ref={iframeRef}
              sandbox="allow-scripts"
              className="w-full h-full border-0 bg-white"
              title={title}
            />
          )}
        </div>

        {/* Footer : code source repliable */}
        <details className="border-t border-border bg-background/40">
          <summary className="cursor-pointer px-4 py-2 text-xs flex items-center gap-2 text-muted hover:bg-muted/10">
            <Code2 size={12} /> Code source ({code.split("\n").length} lignes)
          </summary>
          <pre className="px-4 py-3 text-xs overflow-auto max-h-48 bg-background/60">
            {code}
          </pre>
        </details>
      </div>
    </div>
  );
}
