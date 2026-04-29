/**
 * POST /api/me/delete-conversations — supprime TOUTES les conversations
 * de l'utilisateur courant sur TOUS les agents (RGPD art. 17 — droit
 * à l'oubli, partiel : on n'efface que les conversations Dify, pas
 * son compte ni les fichiers qu'il a uploadés dans la KB).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listAvailableAgents, getAgentKey } from "@/lib/agents";
import { difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  const report: Record<string, { count: number; deleted: number; errors: number }> = {};

  for (const meta of listAvailableAgents()) {
    const key = getAgentKey(meta.slug);
    if (!key) continue;
    let count = 0, deleted = 0, errors = 0;
    try {
      const cr = await difyFetch(
        `/v1/conversations?user=${encodeURIComponent(email)}&limit=100`,
        { key },
      );
      if (cr.ok) {
        const cj = await cr.json();
        for (const conv of cj.data || []) {
          count++;
          try {
            const dr = await difyFetch(
              `/v1/conversations/${conv.id}`,
              {
                method: "DELETE",
                key,
                body: JSON.stringify({ user: email }),
              },
            );
            if (dr.ok || dr.status === 204) deleted++;
            else errors++;
          } catch {
            errors++;
          }
        }
      }
    } catch {
      errors++;
    }
    report[meta.slug] = { count, deleted, errors };
  }

  return NextResponse.json({ ok: true, report });
}
