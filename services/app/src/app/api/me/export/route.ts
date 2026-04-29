/**
 * GET /api/me/export — exporte toutes les données personnelles de
 * l'utilisateur courant (RGPD article 20 — droit à la portabilité).
 *
 * Inclut :
 *   - Profil Authentik (username, name, email, groups, dates)
 *   - Pour chaque agent : la liste des conversations + tous les messages
 *
 * Format : JSON unique (téléchargement en attachment).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listAvailableAgents, AGENTS, getAgentKey } from "@/lib/agents";
import { difyFetch } from "@/lib/dify";
import { akFetch } from "@/lib/authentik";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  // Profil Authentik (best-effort — peut être indispo selon configuration).
  // On cherche par email exact (?email=) ; fallback sur ?search= si non trouvé.
  let profile: unknown = null;
  try {
    let r = await akFetch(`/core/users/?email=${encodeURIComponent(email)}`);
    let u = r.ok ? ((await r.json()).results || [])[0] : null;
    if (!u) {
      r = await akFetch(`/core/users/?search=${encodeURIComponent(email)}`);
      u = r.ok ? ((await r.json()).results || [])[0] : null;
    }
    if (u) {
      profile = {
        username: u.username,
        name: u.name,
        email: u.email,
        groups: u.groups,
        last_login: u.last_login,
        date_joined: u.date_joined,
        is_active: u.is_active,
      };
    }
  } catch { /* noop */ }

  // Conversations + messages par agent (le user est scopé par email Dify)
  const agentsExport: Record<string, unknown> = {};
  for (const meta of listAvailableAgents()) {
    const key = getAgentKey(meta.slug);
    if (!key) continue;
    const conversations: unknown[] = [];
    try {
      // 1. liste des conversations
      const cr = await difyFetch(
        `/v1/conversations?user=${encodeURIComponent(email)}&limit=100`,
        { key },
      );
      if (cr.ok) {
        const cj = await cr.json();
        for (const conv of cj.data || []) {
          // 2. messages de la conversation
          let messages: unknown[] = [];
          try {
            const mr = await difyFetch(
              `/v1/messages?user=${encodeURIComponent(email)}` +
              `&conversation_id=${conv.id}&limit=100`,
              { key },
            );
            if (mr.ok) {
              const mj = await mr.json();
              messages = mj.data || [];
            }
          } catch { /* skip */ }
          conversations.push({ ...conv, messages });
        }
      }
    } catch { /* skip agent */ }
    agentsExport[meta.slug] = {
      agent_name: meta.name,
      conversations_count: conversations.length,
      conversations,
    };
    // garder un alias public pour le détail
    void AGENTS;
  }

  const payload = {
    exported_at: new Date().toISOString(),
    user_email: email,
    profile,
    agents: agentsExport,
    note:
      "Cet export est fourni au titre du droit à la portabilité (RGPD art. 20). " +
      "Conservez-le en lieu sûr — il contient l'intégralité de vos conversations.",
  };

  const filename = `aibox-export-${email.replace(/[^a-zA-Z0-9.-]/g, "_")}-` +
    new Date().toISOString().slice(0, 10) + ".json";
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
