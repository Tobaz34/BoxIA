/**
 * GET /api/agents-tools/gmail_search?q=facture+2026&max=20
 *
 * Recherche dans Gmail avec la syntaxe native Gmail
 * (https://support.google.com/mail/answer/7190). Le LLM doit fournir
 * la requête textuelle telle qu'un humain la taperait dans la barre
 * de recherche Gmail.
 *
 * Exemples : `from:contact@xefi.fr`, `subject:facture is:unread`,
 *            `before:2026/04/01 has:attachment`
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError, toolValidationError } from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "gmail_search", req });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    tracer.failure({ errorCode: "missing_q", retryable: false, httpStatus: 400 });
    return toolValidationError("missing_q", "Paramètre `q` requis");
  }
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));

  const tok = await getToolToken("google", "gmail");
  if (!tok.ok) {
    tracer.failure({
      errorCode: tok.body.error,
      retryable: false,
      httpStatus: tok.status,
      metadata: { stage: "get_tool_token" },
    });
    return toolError({
      error: tok.body.error,
      hint: tok.body.hint || "Connecteur Google non disponible.",
      status: tok.status,
      retryable: false,
    });
  }

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`;
  const listR = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!listR.ok) {
    const detail = (await listR.text().catch(() => "")).slice(0, 200);
    const retryable = listR.status === 429 || listR.status === 408 || listR.status >= 500;
    tracer.failure({
      errorCode: `gmail_search_${listR.status}`,
      retryable,
      httpStatus: retryable ? 502 : listR.status,
      metadata: { upstream_status: listR.status },
    });
    return toolError({
      error: `gmail_search_${listR.status}`,
      hint: retryable
        ? "Gmail a renvoyé une erreur transitoire. Réessayable."
        : "Gmail a refusé la requête (auth/permissions/syntaxe). Vérifie le connecteur.",
      status: retryable ? 502 : listR.status,
      retryable,
      detail,
    });
  }
  const listJ = await listR.json();
  const messages = (listJ.messages || []) as { id: string; threadId: string }[];

  const items = await Promise.all(
    messages.slice(0, max).map(async (m) => {
      const detailR = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${tok.token}` } },
      );
      if (!detailR.ok) return { id: m.id, error: `detail_${detailR.status}` };
      const d = await detailR.json();
      const h: Record<string, string> = {};
      for (const x of d.payload?.headers || []) h[(x.name || "").toLowerCase()] = x.value;
      return {
        id: d.id,
        thread_id: d.threadId,
        from: h.from || "?",
        subject: h.subject || "(sans objet)",
        date: h.date || "?",
        snippet: d.snippet || "",
      };
    }),
  );

  tracer.success(
    {
      count: items.length,
      total_estimated: listJ.resultSizeEstimate,
    },
    { account: tok.account_email, max },
  );
  return NextResponse.json({
    account: tok.account_email,
    query: q,
    count: items.length,
    total_estimated: listJ.resultSizeEstimate || items.length,
    items,
  });
}
