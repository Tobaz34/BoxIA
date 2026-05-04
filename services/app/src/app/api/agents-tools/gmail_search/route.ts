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

  const tok = await getToolToken("google", "gmail-workspace");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`;
  const listR = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!listR.ok) {
    return apiError(listR.status, `gmail_search_${listR.status}`, await listR.text().catch(() => ""));
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

  return NextResponse.json({
    account: tok.account_email,
    query: q,
    count: items.length,
    total_estimated: listJ.resultSizeEstimate || items.length,
    items,
  });
}
