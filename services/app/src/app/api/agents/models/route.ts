/**
 * GET /api/agents/models
 *
 * Liste les modèles disponibles pour les agents IA :
 *  - "installed" : modèles présents sur Ollama (/api/tags) — taille, params
 *  - "registered" : modèles enregistrés côté Dify provider Ollama
 *  - "merged" : fusion installés + enregistrés avec drapeaux
 *
 * Réservé aux admins. Utilisé par le sélecteur de modèle dans /agents.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listInstalledOllamaModels } from "@/lib/ollama";
import { listOllamaModelsInDify } from "@/lib/dify-console";

export const dynamic = "force-dynamic";

// Modèles dont le but n'est PAS la conversation (embeddings, vision dédiés...).
// On les expose pour info mais on les filtre par défaut côté UI sélecteur d'agent.
const NON_CHAT_FAMILIES = ["bge", "nomic", "mxbai"];

function isChatModel(name: string): boolean {
  const lower = name.toLowerCase();
  for (const f of NON_CHAT_FAMILIES) {
    if (lower.startsWith(f)) return false;
  }
  return true;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [installed, registered] = await Promise.all([
    listInstalledOllamaModels(),
    listOllamaModelsInDify(),
  ]);

  const regSet = new Set(registered);
  const installedNames = new Set(installed.map((m) => m.name));

  // Pour chaque modèle installé : son statut Dify
  const merged = installed.map((m) => ({
    name: m.name,
    size: m.size,
    size_label: m.size_label,
    family: m.family,
    parameter_size: m.parameter_size,
    quantization: m.quantization,
    chat: isChatModel(m.name),
    installed: true,
    registered: regSet.has(m.name),
  }));

  // Modèles enregistrés Dify mais désinstallés Ollama : les ajouter en orphelins
  for (const r of registered) {
    if (!installedNames.has(r)) {
      merged.push({
        name: r,
        size: 0,
        size_label: "—",
        family: undefined,
        parameter_size: undefined,
        quantization: undefined,
        chat: isChatModel(r),
        installed: false,
        registered: true,
      });
    }
  }

  // Tri : modèles chat d'abord, puis par taille décroissante
  merged.sort((a, b) => {
    if (a.chat !== b.chat) return a.chat ? -1 : 1;
    return b.size - a.size;
  });

  return NextResponse.json({
    models: merged,
    counts: {
      installed: installed.length,
      registered: registered.length,
      chat_available: merged.filter((m) => m.chat && m.installed).length,
    },
  });
}
