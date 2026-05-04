/**
 * GET /api/agents-tools/gmail_read_inbox?max=20&unread=1
 *
 * Tool Dify pour l'agent « Tri emails » et le Concierge. Retourne les
 * derniers emails de la boîte de l'utilisateur connecté via OAuth Google.
 *
 * Réponse parseable par le LLM :
 *   { account: "x@y.fr", count: 20, items: [
 *       { id, thread_id, from, to, subject, date, snippet, unread, has_attachments }
 *     ]}
 *
 * Auth : Bearer AGENTS_API_KEY (cf lib/agents-tools-auth.ts).
 * OAuth : token OAuth utilisateur récupéré via getAccessToken("google:gmail-workspace").
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken, apiError } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));
  const unreadOnly = url.searchParams.get("unread") === "1";

  const tok = await getToolToken("google", "gmail-workspace");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  // 1. Liste des IDs de message
  const q = unreadOnly ? "is:unread in:inbox" : "in:inbox";
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`;
  const listR = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!listR.ok) {
    return apiError(listR.status, `gmail_list_${listR.status}`, await listR.text().catch(() => ""));
  }
  const listJ = await listR.json();
  const messages = (listJ.messages || []) as { id: string; threadId: string }[];
  if (messages.length === 0) {
    return NextResponse.json({
      account: tok.account_email,
      count: 0,
      items: [],
      hint: unreadOnly ? "Aucun email non lu dans inbox." : "Inbox vide.",
    });
  }

  // 2. Fetch metadata pour chaque message (en parallèle, limité à 20 pour ne
  //    pas saturer)
  const items = await Promise.all(
    messages.slice(0, max).map(async (m) => {
      const detailR = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${tok.token}` } },
      );
      if (!detailR.ok) {
        return { id: m.id, thread_id: m.threadId, error: `detail_${detailR.status}` };
      }
      const d = await detailR.json();
      const headers: Record<string, string> = {};
      for (const h of d.payload?.headers || []) {
        const name = (h.name || "").toLowerCase();
        if (["from", "to", "subject", "date"].includes(name)) {
          headers[name] = h.value;
        }
      }
      return {
        id: d.id,
        thread_id: d.threadId,
        from: headers.from || "?",
        to: headers.to || "?",
        subject: headers.subject || "(sans objet)",
        date: headers.date || "?",
        snippet: d.snippet || "",
        unread: (d.labelIds || []).includes("UNREAD"),
        starred: (d.labelIds || []).includes("STARRED"),
        has_attachments: (d.payload?.parts || []).some((p: { filename?: string }) => p.filename),
        labels: (d.labelIds || []).filter((l: string) => !["INBOX", "UNREAD", "STARRED"].includes(l)),
      };
    }),
  );

  return NextResponse.json({
    account: tok.account_email,
    count: items.length,
    items,
    query: q,
  });
}
