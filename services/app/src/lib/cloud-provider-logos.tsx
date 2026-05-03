/**
 * Logos SVG inline des providers cloud BYOK supportés.
 *
 * SVG inline (pas <img> distantes) pour respecter le principe
 * "self-hosted = aucun fetch externe au runtime". Les logos sont
 * stylisés (pas les marques officielles complètes) pour rester dans
 * la fair-use UI nominative.
 *
 * Couleurs OFF (provider non configuré) → grisaille via CSS opacity.
 * Couleurs ON (configuré) → couleurs natives du provider.
 */
import type { CloudProviderId } from "@/lib/cloud-providers";

interface LogoProps {
  size?: number;
  className?: string;
  /** Si true, utilise les couleurs natives. Si false, version monochrome
   *  (pour tier ON/OFF visuel). */
  colored?: boolean;
}

/** OpenAI : swirl noir/blanc (officiel). En version "colored" on garde
 *  le noir. En non-colored, currentColor. */
export function OpenAiLogo({ size = 16, className, colored = true }: LogoProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={className}
      fill={colored ? "currentColor" : "currentColor"}
      aria-label="OpenAI"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.79A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.792a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

/** Google AI / Gemini : étoile à 4 branches multicolore (officiel Gemini). */
export function GoogleLogo({ size = 16, className, colored = true }: LogoProps) {
  if (!colored) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Google Gemini">
        <path
          fill="currentColor"
          d="M12 0c.5 5.5 6 11 11.5 12-5.5 1-11 6.5-11.5 12C11.5 18.5 6 13 .5 12 6 11 11.5 5.5 12 0z"
        />
      </svg>
    );
  }
  // Mode colored : Gemini star avec dégradé bleu/violet/rouge
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Google Gemini">
      <defs>
        <linearGradient id="gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="40%" stopColor="#9B72CB" />
          <stop offset="80%" stopColor="#D96570" />
          <stop offset="100%" stopColor="#F9AB00" />
        </linearGradient>
      </defs>
      <path
        fill="url(#gemini-grad)"
        d="M12 0c.5 5.5 6 11 11.5 12-5.5 1-11 6.5-11.5 12C11.5 18.5 6 13 .5 12 6 11 11.5 5.5 12 0z"
      />
    </svg>
  );
}

/** Anthropic Claude : A stylisé orange. */
export function AnthropicLogo({ size = 16, className, colored = true }: LogoProps) {
  const fill = colored ? "#D97706" : "currentColor";
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={className}
      aria-label="Anthropic Claude"
    >
      <path
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.461H0L6.57 3.52zm4.132 9.838L8.453 7.67l-2.248 5.688h4.496z"
        fill={fill}
      />
    </svg>
  );
}

/** Mistral AI : flamme stylisée. */
export function MistralLogo({ size = 16, className, colored = true }: LogoProps) {
  if (!colored) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Mistral">
        <path
          fill="currentColor"
          d="M3 3h3v3H3zM18 3h3v3h-3zM3 6h3v3H3zM18 6h3v3h-3zM3 9h3v3H3zM9 9h3v3H9zM12 9h3v3h-3zM18 9h3v3h-3zM3 12h3v3H3zM9 12h3v3H9zM12 12h3v3h-3zM18 12h3v3h-3zM3 15h3v3H3zM18 15h3v3h-3zM3 18h3v3H3zM9 18h3v3H9zM15 18h3v3h-3zM18 18h3v3h-3z"
        />
      </svg>
    );
  }
  // Mode colored : couleurs Mistral (orange/jaune dégradé)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Mistral">
      <rect x="3" y="3" width="3" height="3" fill="#000" />
      <rect x="6" y="3" width="3" height="3" fill="#F0B90B" />
      <rect x="9" y="3" width="3" height="3" fill="#F0B90B" />
      <rect x="12" y="3" width="3" height="3" fill="#F0B90B" />
      <rect x="15" y="3" width="3" height="3" fill="#F0B90B" />
      <rect x="18" y="3" width="3" height="3" fill="#000" />
      <rect x="3" y="6" width="3" height="3" fill="#000" />
      <rect x="6" y="6" width="3" height="3" fill="#F08C0B" />
      <rect x="9" y="6" width="3" height="3" fill="#F08C0B" />
      <rect x="15" y="6" width="3" height="3" fill="#F08C0B" />
      <rect x="18" y="6" width="3" height="3" fill="#000" />
      <rect x="3" y="9" width="3" height="3" fill="#000" />
      <rect x="6" y="9" width="3" height="3" fill="#F0680B" />
      <rect x="15" y="9" width="3" height="3" fill="#F0680B" />
      <rect x="18" y="9" width="3" height="3" fill="#000" />
      <rect x="3" y="12" width="3" height="3" fill="#000" />
      <rect x="6" y="12" width="3" height="3" fill="#E6440B" />
      <rect x="15" y="12" width="3" height="3" fill="#E6440B" />
      <rect x="18" y="12" width="3" height="3" fill="#000" />
      <rect x="3" y="15" width="3" height="3" fill="#000" />
      <rect x="6" y="15" width="3" height="3" fill="#D11A0B" />
      <rect x="9" y="15" width="3" height="3" fill="#D11A0B" />
      <rect x="12" y="15" width="3" height="3" fill="#D11A0B" />
      <rect x="15" y="15" width="3" height="3" fill="#D11A0B" />
      <rect x="18" y="15" width="3" height="3" fill="#000" />
    </svg>
  );
}

/** Helper : retourne le bon composant pour un id. */
export function ProviderLogo({
  id, size = 16, className, colored = true,
}: LogoProps & { id: CloudProviderId }) {
  if (id === "openai") return <OpenAiLogo size={size} className={className} colored={colored} />;
  if (id === "anthropic") return <AnthropicLogo size={size} className={className} colored={colored} />;
  if (id === "google") return <GoogleLogo size={size} className={className} colored={colored} />;
  if (id === "mistral") return <MistralLogo size={size} className={className} colored={colored} />;
  return null;
}

export const PROVIDER_LABELS: Record<CloudProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  google: "Gemini",
  mistral: "Mistral",
};
