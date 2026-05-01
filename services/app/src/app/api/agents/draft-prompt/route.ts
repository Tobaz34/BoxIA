/**
 * POST /api/agents/draft-prompt
 *
 * Génère un brouillon de pre-prompt + opening + 4 questions suggérées
 * via Ollama qwen2.5:14b à partir des choix wizard. Utilisé en preview
 * avant la création effective de l'agent.
 *
 * Body :
 *   { name, description, domain, tone, language?, expertise_keywords? }
 *
 * Réponse :
 *   { pre_prompt, opening_statement, suggested_questions, generation_ms, fallback }
 *
 * Réservé aux admins.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { draftAgentPrompt } from "@/lib/ollama-prompt-gen";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    name?: string;
    description?: string;
    domain?: string;
    tone?: string;
    language?: string;
    expertise_keywords?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  if (!body.name || !body.domain || !body.tone) {
    return NextResponse.json(
      { error: "missing_fields", message: "name, domain, tone requis" },
      { status: 400 },
    );
  }

  const result = await draftAgentPrompt({
    name: body.name.slice(0, 80),
    description: (body.description || "").slice(0, 200),
    domain: body.domain,
    tone: body.tone,
    language: body.language,
    expertise_keywords: body.expertise_keywords?.slice(0, 500),
  });
  return NextResponse.json(result);
}
