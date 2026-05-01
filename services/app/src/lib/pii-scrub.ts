/**
 * PII Scrubber — caviarde les données personnelles avant envoi cloud.
 *
 * Patterns détectés (best-effort, FR-centric) :
 *   - Emails : @
 *   - Téléphones FR : 0X.XX.XX.XX.XX (avec séparateurs) ou +33...
 *   - SIRET / SIREN : 14 / 9 chiffres consécutifs
 *   - SSN FR (NIR) : 1 ou 2 + 2 chiffres + 2 chiffres + 2 chiffres + ...
 *   - IBAN : FR76...
 *   - Cartes bancaires : 16 chiffres groupés
 *
 * Limites connues :
 *   - Pas de NER (named entity recognition) → pas de détection de noms
 *     propres (« Jean Dupont »). Pour ça il faudrait un modèle spaCy
 *     ou un appel LLM en pré-traitement (coût). Backlog V1.1.
 *   - Adresses postales partiellement détectables.
 *
 * Usage :
 *   const { redacted, count } = scrubPII(text);
 *   // count > 0 → afficher un warning UI : "X PII caviardé(s) avant envoi cloud"
 */

interface ScrubPattern {
  name: string;
  re: RegExp;
  /** Replacement (peut être fonction si on veut garder un repère). */
  replacement: string;
}

const PATTERNS: ScrubPattern[] = [
  {
    name: "email",
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "phone_fr",
    // 06 12 34 56 78, 06.12.34.56.78, +33 6 12 34 56 78, 06-12-34-56-78
    re: /(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/g,
    replacement: "[PHONE_REDACTED]",
  },
  {
    name: "iban",
    // IBAN FR (27 chars) — focus FR mais le pattern matche large
    re: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){4,7}[A-Z0-9]{1,4}\b/g,
    replacement: "[IBAN_REDACTED]",
  },
  {
    name: "credit_card",
    // 4 groupes de 4 chiffres séparés par espaces / tirets / rien
    re: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    replacement: "[CARD_REDACTED]",
  },
  {
    name: "siret",
    // SIRET 14 chiffres (peut avoir des espaces aux 3-3-3-5)
    re: /\b\d{3}[\s]?\d{3}[\s]?\d{3}[\s]?\d{5}\b/g,
    replacement: "[SIRET_REDACTED]",
  },
  {
    name: "siren",
    // SIREN 9 chiffres (3-3-3 ou 9)
    re: /\b\d{3}[\s]?\d{3}[\s]?\d{3}\b(?!\d)/g,
    replacement: "[SIREN_REDACTED]",
  },
  {
    name: "nir_fr",
    // NIR français (sécu sociale) 13 chars + 2 clé : 1 84 04 75 116 003 42
    re: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2}\b/g,
    replacement: "[NIR_REDACTED]",
  },
];

export interface ScrubResult {
  redacted: string;
  count: number;
  by_type: Record<string, number>;
}

export function scrubPII(text: string): ScrubResult {
  if (!text) return { redacted: text, count: 0, by_type: {} };
  let out = text;
  let count = 0;
  const byType: Record<string, number> = {};
  for (const p of PATTERNS) {
    out = out.replace(p.re, () => {
      count++;
      byType[p.name] = (byType[p.name] || 0) + 1;
      return p.replacement;
    });
  }
  return { redacted: out, count, by_type: byType };
}

/** Helper côté UI pour afficher un avertissement clair à l'utilisateur. */
export function summarizeScrub(result: ScrubResult): string {
  if (result.count === 0) return "Aucune donnée personnelle détectée.";
  const parts = Object.entries(result.by_type)
    .map(([type, n]) => `${n} ${type}${n > 1 ? "s" : ""}`)
    .join(", ");
  return `${result.count} donnée${result.count > 1 ? "s" : ""} personnelle${result.count > 1 ? "s" : ""} caviardée${result.count > 1 ? "s" : ""} avant envoi cloud (${parts}).`;
}
