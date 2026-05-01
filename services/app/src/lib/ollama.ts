/**
 * Client Ollama pour l'app — listing des modèles installés localement,
 * récupération des métadonnées (taille, paramètres, etc.).
 *
 * À ne pas confondre avec /lib/dify-console.ts qui gère les modèles
 * "enregistrés dans Dify" (provider_models). Un modèle peut être
 * installé sur Ollama sans être enregistré dans Dify (et inversement,
 * mais alors Dify renverra dify_upstream_error au runtime).
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export interface OllamaModel {
  name: string;        // ex: "qwen2.5:14b"
  size: number;        // octets
  size_label: string;  // ex: "9.0 GB"
  family?: string;     // ex: "qwen2"
  parameter_size?: string; // ex: "14.8B"
  quantization?: string;   // ex: "Q4_K_M"
  modified_at: string;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

interface OllamaTagDetails {
  family?: string;
  parameter_size?: string;
  quantization_level?: string;
}
interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    size: number;
    modified_at: string;
    details?: OllamaTagDetails;
  }>;
}

/** Liste les modèles installés sur le serveur Ollama via /api/tags. */
export async function listInstalledOllamaModels(): Promise<OllamaModel[]> {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as OllamaTagsResponse;
    return (j.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      size_label: fmtSize(m.size),
      family: m.details?.family,
      parameter_size: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      modified_at: m.modified_at,
    }));
  } catch {
    return [];
  }
}
