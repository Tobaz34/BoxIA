/**
 * GET /api/agents-tools/outlook_search?q=facture&max=20
 *
 * Recherche dans toute la mailbox Outlook via Microsoft Graph
 * `/me/messages?$search=...`. Le LLM doit fournir une query texte
 * (pas la syntaxe Gmail). Graph supporte les quotes et opérateurs
 * AND/OR mais c'est plus limité que Gmail.
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken, apiError } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return NextResponse.json({ error: "missing_q", hint: "?q=... requis" }, { status: 400 });
  }
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));

  const tok = await getToolToken("microsoft", "outlook-graph");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  const select = "id,conversationId,subject,from,receivedDateTime,bodyPreview";
  // Note : Graph $search n'accepte pas $orderby ni $top ensemble dans
  // certains scénarios. On utilise $top + ConsistencyLevel header.
  const graphUrl =
    `https://graph.microsoft.com/v1.0/me/messages` +
    `?$search="${encodeURIComponent(q)}"&$top=${max}&$select=${select}`;

  const r = await fetch(graphUrl, {
    headers: {
      Authorization: `Bearer ${tok.token}`,
      ConsistencyLevel: "eventual",
    },
  });
  if (!r.ok) {
    return apiError(r.status, `graph_search_${r.status}`, await r.text().catch(() => ""));
  }
  const j = await r.json();
  const items = (j.value || []).map((m: {
    id: string; conversationId: string; subject?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    receivedDateTime?: string; bodyPreview?: string;
  }) => ({
    id: m.id,
    conversation_id: m.conversationId,
    from: m.from?.emailAddress?.address || "?",
    subject: m.subject || "(sans objet)",
    date: m.receivedDateTime,
    snippet: m.bodyPreview || "",
  }));

  return NextResponse.json({
    account: tok.account_email,
    query: q,
    count: items.length,
    items,
  });
}
