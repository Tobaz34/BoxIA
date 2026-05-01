/**
 * Smooth streaming — découpe les gros deltas SSE en chunks 1-3 chars
 * pour donner l'impression que l'agent « tape » comme un humain.
 *
 * Pattern repris d'Open-WebUI (`src/lib/apis/streaming/index.ts`,
 * fonction `streamLargeDeltasAsRandomChunks`). Adapté ici en utilitaire
 * async/await consommable depuis n'importe quel handler de stream.
 *
 * Bénéfices UX :
 *   - Évite les bursts moches « 200 chars d'un coup » que renvoie
 *     parfois Dify quand le LLM produit vite (Qwen3 sur prompt court).
 *   - Lecture plus naturelle, suit l'œil de l'utilisateur.
 *   - Skip l'animation si l'onglet est en arrière-plan (timer throttling
 *     navigateur → de toute façon on n'aurait pas 5ms de précision).
 *
 * Coût :
 *   - +5ms par chunk de 1-3 chars max → pour un message de 500 chars
 *     ça ajoute ~1s sur la durée perçue. Largement acceptable vs
 *     l'attente de 30s+ du LLM.
 *
 * Usage :
 *   await smoothEmit(delta, (chunk) => {
 *     setMessages(m => m.map(x => x.id === id
 *       ? { ...x, content: x.content + chunk }
 *       : x));
 *   });
 */
const MIN_CHUNK_LEN_TO_SMOOTH = 5;
const TICK_MS = 5;

export async function smoothEmit(
  text: string,
  onChunk: (chunk: string) => void,
): Promise<void> {
  // Petits deltas (≤ 4 chars) : on émet en une fois, l'effet humain est
  // déjà naturel sans découpage supplémentaire.
  if (!text) return;
  if (text.length < MIN_CHUNK_LEN_TO_SMOOTH) {
    onChunk(text);
    return;
  }
  // Si l'onglet est caché → emit en bloc (timer throttling rend
  // l'animation laide ET coûte CPU pour rien)
  const tabHidden =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  if (tabHidden) {
    onChunk(text);
    return;
  }

  let pos = 0;
  while (pos < text.length) {
    const size = Math.min(
      Math.floor(Math.random() * 3) + 1, // 1..3
      text.length - pos,
    );
    onChunk(text.slice(pos, pos + size));
    pos += size;
    // Si pendant le tick l'onglet passe en arrière-plan, on flush le
    // reste sans attendre.
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      onChunk(text.slice(pos));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, TICK_MS));
  }
}
