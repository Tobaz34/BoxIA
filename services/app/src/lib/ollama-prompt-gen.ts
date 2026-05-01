/**
 * Génère un pre-prompt pour un nouvel agent custom via un meta-prompt à
 * un modèle Ollama (qwen2.5:14b par défaut).
 *
 * On garde le contrôle sur le format de sortie en spécifiant explicitement
 * un schéma JSON dans le meta-prompt et en parsant la réponse. Si le
 * modèle dérape, on retombe sur un template par défaut.
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const DRAFT_MODEL = process.env.AGENT_DRAFT_MODEL || "qwen2.5:14b";

const TONE_LABELS: Record<string, string> = {
  formal: "professionnel et formel, vouvoiement, terminologie précise",
  friendly: "convivial et accessible, tutoiement bienveillant, pédagogique",
  direct: "factuel et concis, sans bavardage, droit au but",
};

const DOMAIN_GUIDANCE: Record<string, string> = {
  "comptabilité": "TVA, devis, factures, déclarations CFE/IS/IR, bilans",
  "rh": "congés, contrats CDI/CDD, droit du travail français, paie",
  "support-client": "réponses commerciales empathiques, gestion réclamations",
  "commercial": "argumentaires, propositions, négociation, prospection",
  "juridique": "rappels CGV/CGU, clauses contrats, RGPD, conformité",
  "marketing": "rédaction emails, posts, plans éditoriaux, SEO",
  "technique-it": "support informatique, dépannage, scripts, doc procédures",
  "autre": "généraliste métier",
};

export interface DraftPromptInput {
  name: string;            // ex: "Assistant juridique"
  description: string;     // 1 ligne
  domain: string;          // clé domain
  tone: string;            // formal | friendly | direct
  language?: string;       // défaut fr-FR
  expertise_keywords?: string;  // user free-text optionnel
}

export interface DraftPromptOutput {
  pre_prompt: string;
  opening_statement: string;
  suggested_questions: string[];
  generation_ms: number;
  fallback: boolean;       // true si on a utilisé le template par défaut
}

/** Construit le meta-prompt envoyé au modèle générateur. */
function buildMetaPrompt(input: DraftPromptInput): string {
  const domainGuide = DOMAIN_GUIDANCE[input.domain] || "généraliste";
  const toneGuide = TONE_LABELS[input.tone] || TONE_LABELS.friendly;
  const lang = input.language || "fr-FR";

  return `Tu es un expert en design d'assistants IA pour TPE/PME françaises.

Génère la configuration d'un agent IA avec ces caractéristiques :
- Nom : ${input.name}
- Description courte : ${input.description}
- Domaine d'expertise : ${input.domain} (${domainGuide})
- Ton : ${toneGuide}
- Langue : ${lang}
${input.expertise_keywords ? `- Précisions du créateur : ${input.expertise_keywords}` : ""}

L'agent généré devra savoir produire des LIVRABLES (Word, Excel, PDF, scripts) en utilisant la syntaxe officielle de l'AI Box :

  [FILE:nom-du-fichier.ext]
  ...contenu en markdown ou texte brut...
  [/FILE]

Extensions supportées : .docx (Word) / .xlsx (Excel, basé sur les tables markdown) / .pdf / .ps1, .sh, .py (scripts) / .csv .json .md (texte). Le système convertit automatiquement le contenu vers le bon format. Pour Excel, l'agent doit toujours formater les données en tables markdown. Pour Word et PDF, du markdown classique (titres, listes, tables) suffit.

Le pre_prompt doit donc inclure un paragraphe expliquant cette capacité de génération de fichiers et donner 1 ou 2 exemples typiques pour le domaine concerné (ex: pour un agent comptable → "génère un devis Excel quand on te le demande").

Réponds UNIQUEMENT avec un JSON valide (pas de markdown, pas de \`\`\`) au format exact :
{
  "pre_prompt": "Le system prompt de l'agent. 6-10 lignes. Commence par 'Tu es...'. Précise le rôle, l'expertise (français : législation FR, normes FR), le ton, la langue, les limites (par ex. rappel que tu n'es pas un avocat/expert-comptable agréé pour les questions juridiques), ET la capacité à générer des fichiers via la syntaxe [FILE:...].",
  "opening_statement": "Phrase d'accueil affichée au démarrage. 1-2 phrases. Présente l'agent et invite à poser une question.",
  "suggested_questions": ["Question concrète 1", "Question concrète 2", "Question concrète 3", "Question concrète 4"]
}

Les 4 questions suggérées doivent être très concrètes et utiles pour le quotidien d'une TPE/PME française. Au moins UNE des 4 doit demander la génération d'un livrable (ex: "Génère-moi un modèle de devis Excel pour…"). Pas de généralités.`;
}

/** Template fallback si le modèle ne répond pas correctement. */
function fallbackPrompt(input: DraftPromptInput): DraftPromptOutput {
  const lang = input.language || "français";
  return {
    pre_prompt:
      `Tu es ${input.name}, un assistant spécialisé dans le domaine : ${input.description}. ` +
      `Tu réponds en ${lang} avec un ton ${TONE_LABELS[input.tone] || "professionnel"}. ` +
      `Tu es expert sur la législation et les pratiques françaises. ` +
      `Pour les questions complexes ou réglementées, rappelle systématiquement à l'utilisateur ` +
      `de consulter un professionnel agréé. Cite tes sources quand c'est pertinent.`,
    opening_statement:
      `Bonjour ! Je suis ${input.name}. ${input.description} ` +
      `Comment puis-je vous aider aujourd'hui ?`,
    suggested_questions: [
      `Quelles sont les règles de base en ${input.domain} pour une TPE/PME ?`,
      `Aide-moi à rédiger un document type pour mon activité`,
      `Quelles sont les obligations légales actuelles dans ce domaine ?`,
      `Donne-moi un exemple concret adapté à mon entreprise`,
    ],
    generation_ms: 0,
    fallback: true,
  };
}

/** Extrait un objet JSON depuis une réponse LLM (qui peut contenir
 *  du markdown ou des préfixes/suffixes). */
function extractJson(raw: string): unknown | null {
  // Cas le plus simple
  try { return JSON.parse(raw); } catch { /* continue */ }
  // Cherche le 1er { et le } correspondant
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

export async function draftAgentPrompt(
  input: DraftPromptInput,
): Promise<DraftPromptOutput> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DRAFT_MODEL,
        prompt: buildMetaPrompt(input),
        format: "json",       // Ollama force le JSON output (depuis 0.1.30)
        stream: false,
        options: {
          temperature: 0.4,   // basse pour la cohérence
          num_predict: 1024,
        },
        keep_alive: "10m",
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) {
      console.warn("[ollama-prompt-gen] HTTP", r.status);
      return fallbackPrompt(input);
    }
    const j = await r.json();
    const parsed = extractJson(j.response || "");
    if (!parsed || typeof parsed !== "object") {
      return fallbackPrompt(input);
    }
    const o = parsed as Record<string, unknown>;
    const pp = typeof o.pre_prompt === "string" ? o.pre_prompt : "";
    const op = typeof o.opening_statement === "string" ? o.opening_statement : "";
    const sq = Array.isArray(o.suggested_questions)
      ? o.suggested_questions.filter((q): q is string => typeof q === "string").slice(0, 4)
      : [];
    if (!pp || pp.length < 20) {
      return fallbackPrompt(input);
    }
    return {
      pre_prompt: pp.slice(0, 2000),
      opening_statement: op.slice(0, 400) || `Bonjour ! Je suis ${input.name}.`,
      suggested_questions: sq.length > 0 ? sq : fallbackPrompt(input).suggested_questions,
      generation_ms: Date.now() - t0,
      fallback: false,
    };
  } catch (e) {
    console.warn("[ollama-prompt-gen] error:", e);
    return fallbackPrompt(input);
  }
}
