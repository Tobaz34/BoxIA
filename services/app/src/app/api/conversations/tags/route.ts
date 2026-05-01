/**
 * Tags de conversations — couche locale BoxIA (Dify n'expose pas de
 * modèle de tags via REST, on garde un mapping local).
 *
 * GET /api/conversations/tags
 *   → { user_tags: { tag, count }[], conv_tags: { <conv_id>: tags[] } }
 *
 * POST /api/conversations/tags
 *   body : { conversation_id: string, tags: string[] }
 *   → { ok: true, conversation_id, tags: <tags-normalisés> }
 *
 * Auth : session NextAuth requise (les tags sont scoppés par user_email).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getUserTagsMap,
  listAllUserTags,
  setTags,
} from "@/lib/conversation-tags";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [user_tags, conv_tags] = await Promise.all([
    listAllUserTags(email),
    getUserTagsMap(email),
  ]);
  return NextResponse.json({ user_tags, conv_tags });
}

interface PostBody {
  conversation_id?: string;
  tags?: string[];
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const convId = body.conversation_id;
  if (!convId || typeof convId !== "string") {
    return NextResponse.json({ error: "missing_conversation_id" }, { status: 400 });
  }
  if (!Array.isArray(body.tags)) {
    return NextResponse.json({ error: "tags_must_be_array" }, { status: 400 });
  }
  const cleaned = await setTags(email, convId, body.tags);
  return NextResponse.json({ ok: true, conversation_id: convId, tags: cleaned });
}
