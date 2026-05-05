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
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError, toolValidationError } from "@/lib/tool-errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return toolValidationError("missing_q", "Paramètre `q` requis");
  }
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));

  const tok = await getToolToken("microsoft", "outlook-graph");
  if (!tok.ok) {
    return toolError({
      error: tok.body.error,
      hint: tok.body.hint || "Connecteur Microsoft non disponible.",
      status: tok.status,
      retryable: false,
    });
  }

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
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    // 4xx (sauf 429/408) = non retryable (auth/perm/syntax). 5xx + 429 = retryable.
    const retryable = r.status === 429 || r.status === 408 || r.status >= 500;
    return toolError({
      error: `graph_search_${r.status}`,
      hint: retryable
        ? "Microsoft Graph a renvoyé une erreur transitoire. Réessayable."
        : "Microsoft Graph a refusé la requête (auth/permissions/syntaxe). Vérifie le connecteur.",
      status: retryable ? 502 : r.status,
      retryable,
      detail,
    });
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
