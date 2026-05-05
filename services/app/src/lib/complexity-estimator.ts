/**
 * ComplexityEstimator — pre-routing HIGH / LOW pour le Concierge.
 *
 * Pourquoi : les tâches multi-step (« trouve facture 2024 X dans Pennylane,
 * télécharge le PDF, envoie par mail ») gagnent à passer en mode plan-replan
 * (P0 #5 [REPLAN-V1]) où le LLM décompose en steps + gère les fails. Mais
 * pour les questions triviales (« quelle heure est-il ? », « bonjour »), le
 * mode plan est overkill et fait perdre des tokens.
 *
 * Cet estimateur classifie en HIGH/LOW via heuristiques :
 *  - longueur de la requête
 *  - nombre de mentions tools / connecteurs
 *  - verbes d'action chaînés
 *  - mention explicite « puis », « et après », « ensuite »
 *
 * En V1 c'est purement heuristique. En V2 on passera à un few-shot LLM
 * (qwen3:1.7b CPU pour rester léger) si les heuristiques ratent trop.
 *
 * Référence : tools/research/audit_P0_05_replan.md +
 *             DECISIONS-P0.md §D4 (Option A prompt-only) +
 *             AgenticSeek `router.py:401 estimate_complexity` (réimplémenté
 *             — license GPL-3 originale, pas de copie)
 */

export type Complexity = "high" | "low";

export interface ComplexityResult {
  complexity: Complexity;
  /** Score 0-100 (plus haut = plus complexe). */
  score: number;
  /** Drapeaux qui ont contribué au score (debug + observability). */
  signals: string[];
}

/**
 * Mots-clés/regex qui indiquent une tâche multi-step ou potentiellement
 * difficile pour qwen3:14b en mode one-shot.
 */
const HIGH_SIGNALS: Array<{ name: string; weight: number; pattern: RegExp }> = [
  // Verbes d'action chainés FR/EN
  { name: "chain_puis", weight: 25, pattern: /\b(puis|ensuite|et après|et ensuite|then)\b/i },
  { name: "chain_et", weight: 12, pattern: /\b(?:et\s+(?:envoie|télécharge|cherche|trouve|installe|crée|génère|envoyer|chercher|créer|génér))\b/i },
  // Mentions explicites de plusieurs tools
  { name: "mention_pennylane", weight: 8, pattern: /\b(pennylane|pennyl)\b/i },
  { name: "mention_outlook", weight: 6, pattern: /\boutlook\b/i },
  { name: "mention_gmail", weight: 6, pattern: /\bgmail\b/i },
  { name: "mention_drive", weight: 6, pattern: /\b(drive|onedrive|sharepoint)\b/i },
  { name: "mention_n8n", weight: 8, pattern: /\b(workflow|automatisation|n8n)\b/i },
  { name: "mention_calendar", weight: 6, pattern: /\b(calendrier|calendar|rdv|rendez-vous|agenda)\b/i },
  // Verbes mutatifs (probable approval gate + action chaînée)
  { name: "verb_send", weight: 15, pattern: /\b(envoie|envoyer|send|réponds par mail|réponds par email)\b/i },
  { name: "verb_install", weight: 18, pattern: /\b(installe|installer|active|configure)\b/i },
  { name: "verb_delete", weight: 18, pattern: /\b(supprime|supprimer|delete)\b/i },
  // Demandes de génération de contenu structurées
  { name: "verb_summarize_then", weight: 14, pattern: /\b(résume|résumer|summarize)\b.{0,50}(puis|et|ensuite|then)\b/i },
  // Multi-document / multi-source
  { name: "multi_doc", weight: 10, pattern: /\b(tous mes|toutes les|chaque|every)\b.*(documents?|emails?|factures?|fichiers?)/i },
  // Conditions / branches
  { name: "conditional", weight: 8, pattern: /\b(si .{1,30}(alors|sinon)|if .{1,30}(then|else))\b/i },
];

/** Mots qui indiquent une question simple/triviale → force LOW. */
const LOW_OVERRIDES: RegExp[] = [
  /^(bonjour|salut|hey|hi|hello|merci|thanks|ok|d'accord|au revoir|bye)\.?$/i,
  /^(quelle heure|what time|what's the time)/i,
  /^(comment ça va|how are you|tu vas bien)/i,
];

const HIGH_THRESHOLD = 25;
const LOW_THRESHOLD = 10;

/**
 * Estime la complexité d'une requête utilisateur.
 *
 * Heuristique :
 *  - Si query matche un LOW_OVERRIDES → low (score 0)
 *  - Sinon, somme les weights des HIGH_SIGNALS qui matchent
 *  - score >= HIGH_THRESHOLD → high
 *  - sinon low
 *
 * En V2 (si fail >30% sur tâches multi-step en prod), on remplacera
 * cette heuristique par un appel few-shot à qwen3:1.7b CPU.
 */
export function estimateComplexity(query: string): ComplexityResult {
  const trimmed = (query || "").trim();

  if (!trimmed) {
    return { complexity: "low", score: 0, signals: ["empty"] };
  }

  // Override low explicite : salutations, questions triviales
  for (const re of LOW_OVERRIDES) {
    if (re.test(trimmed)) {
      return { complexity: "low", score: 0, signals: ["low_override_greeting"] };
    }
  }

  let score = 0;
  const signals: string[] = [];

  // Length-based base score (très léger)
  if (trimmed.length > 200) {
    score += 8;
    signals.push("length>200");
  } else if (trimmed.length > 100) {
    score += 4;
    signals.push("length>100");
  }

  // Pattern matching
  for (const sig of HIGH_SIGNALS) {
    if (sig.pattern.test(trimmed)) {
      score += sig.weight;
      signals.push(sig.name);
    }
  }

  // Comma/period count bonus (multi-clauses → multi-step)
  const sepCount =
    (trimmed.match(/[,.;]/g) || []).length;
  if (sepCount >= 3) {
    score += 6;
    signals.push("seps>=3");
  } else if (sepCount >= 2) {
    score += 3;
    signals.push("seps>=2");
  }

  if (score >= HIGH_THRESHOLD) {
    return { complexity: "high", score, signals };
  }
  if (score <= LOW_THRESHOLD) {
    return { complexity: "low", score, signals };
  }
  // Zone grise — par défaut LOW (préfère ne pas activer plan-replan
  // pour économiser les tokens). Le LLM peut quand même replan si il
  // décide en cours d'exécution (cf [REPLAN-V1] prompt).
  return { complexity: "low", score, signals: [...signals, "grey_zone_default_low"] };
}
