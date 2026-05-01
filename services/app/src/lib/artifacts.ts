/**
 * Artifacts / Canvas — détection de contenu « rendable » dans les
 * réponses de l'assistant.
 *
 * Inspiré de Claude Artifacts : quand le LLM génère un block ```html```,
 * ```svg``` ou ```mermaid```, on lui ajoute un bouton « Voir » qui ouvre
 * un panneau preview side-by-side.
 *
 * Sécurité :
 *  - HTML : rendu dans un <iframe sandbox> (pas d'accès au parent).
 *  - SVG : sanitize basique (strip <script> et handlers `on*`).
 *  - Mermaid : on délègue à mermaid.js qui parse dans son propre scope.
 *
 * Limites connues V1 :
 *  - Pas de React / JSX live (nécessiterait sandpack ou esbuild-wasm,
 *    +2-3 MB de bundle). Backlog si le besoin se confirme.
 *  - Pas de Python (Code Interpreter) — backlog (sandbox sécurisé requis).
 */

export type ArtifactKind = "html" | "svg" | "mermaid";

export interface DetectedArtifact {
  kind: ArtifactKind;
  /** Code source brut (intérieur du fenced block, sans les ```). */
  code: string;
  /** Titre dérivé (premier <title>, premier commentaire, ou « Aperçu »). */
  title: string;
}

/** Renvoie `kind` si la chaîne du `language-*` est rendable, sinon null. */
export function artifactKindFromLang(lang: string | undefined): ArtifactKind | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "mermaid" || l === "mmd") return "mermaid";
  return null;
}

/** Devine un titre depuis le code (pour l'onglet du panneau). */
export function deriveArtifactTitle(kind: ArtifactKind, code: string): string {
  // HTML : <title>X</title>
  if (kind === "html") {
    const m = code.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return m[1].trim().slice(0, 60);
    return "Aperçu HTML";
  }
  // SVG : on cherche un <title> ou un commentaire
  if (kind === "svg") {
    const m = code.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return m[1].trim().slice(0, 60);
    return "Aperçu SVG";
  }
  // Mermaid : 1ère ligne sans `flowchart`/`sequenceDiagram` etc
  if (kind === "mermaid") {
    const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
    const hint = lines.find((l) => /^title\s+/i.test(l));
    if (hint) return hint.replace(/^title\s+/i, "").slice(0, 60);
    return "Diagramme Mermaid";
  }
  return "Aperçu";
}

/**
 * Sanitize basique d'un fragment SVG / HTML : enlève les `<script>` et les
 * attributs `on*` (onclick, onerror, etc.). Pas une protection complète
 * contre XSS — on s'appuie surtout sur l'iframe sandbox pour HTML.
 */
export function basicSanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
}

/**
 * Construit le srcDoc d'iframe pour un artifact HTML : si le code est
 * un document complet (commence par `<!DOCTYPE` ou `<html`), on le passe
 * tel quel. Sinon on l'enveloppe dans un squelette neutre.
 */
export function buildHtmlSrcDoc(code: string): string {
  const trimmed = code.trim();
  if (/^<!doctype/i.test(trimmed) || /^<html\b/i.test(trimmed)) {
    return trimmed;
  }
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;color:#111;background:#fff;}
  *{box-sizing:border-box;}
</style>
</head>
<body>
${trimmed}
</body>
</html>`;
}
