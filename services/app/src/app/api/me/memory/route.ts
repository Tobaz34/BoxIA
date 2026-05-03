/**
 * GET/DELETE /api/me/memory — gestion de la mémoire long-terme du user
 * connecté (mem0).
 *
 * GET : liste les facts mémorisés. Si feature désactivée (MEM0_API_KEY
 * absent), renvoie `{enabled: false, facts: []}` pour que /me cache la
 * section sans afficher d'erreur.
 *
 * DELETE : RGPD art. 17 — suppression complète de la mémoire de ce user.
 *
 * Auth : session NextAuth requise. On utilise l'email comme user_id (cohérent
 * avec lib/memory.ts et chat.ts).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  isMemoryEnabled,
  deleteUserMemory,
  type MemoryFact,
} from "@/lib/memory";

export const dynamic = "force-dynamic";

const MEMORY_BASE_URL = process.env.MEM0_BASE_URL || "http://aibox-mem0:8000";
const MEMORY_API_KEY = process.env.MEM0_API_KEY || "";
const TIMEOUT_MS = 4000;

/** Liste tous les facts mémorisés pour un user. Best-effort : si mem0
 *  ne répond pas, on renvoie une liste vide plutôt que de planter l'UI. */
async function listUserMemory(userId: string): Promise<MemoryFact[]> {
  if (!isMemoryEnabled() || !userId) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(
      `${MEMORY_BASE_URL}/memory/user/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${MEMORY_API_KEY}` },
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.facts) ? data.facts : [];
  } catch {
    return [];
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isMemoryEnabled()) {
    return NextResponse.json({ enabled: false, facts: [] });
  }
  const facts = await listUserMemory(session.user.email);
  return NextResponse.json({ enabled: true, facts });
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await deleteUserMemory(session.user.email);
  if (!result.ok) {
    return NextResponse.json(
      { error: "delete_failed", detail: result.error },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    facts_deleted: result.facts_deleted ?? 0,
  });
}
