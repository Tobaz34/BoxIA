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
 * OAuth : token OAuth utilisateur récupéré via getAccessToken("google:gmail").
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError } from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "gmail_read_inbox", req });

  const url = new URL(req.url);
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));
  const unreadOnly = url.searchParams.get("unread") === "1";

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

  // 1. Liste des IDs de message
  const q = unreadOnly ? "is:unread in:inbox" : "in:inbox";
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`;
  const listR = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!listR.ok) {
    const detail = (await listR.text().catch(() => "")).slice(0, 200);
    const retryable = listR.status === 429 || listR.status === 408 || listR.status >= 500;
    tracer.failure({
      errorCode: `gmail_list_${listR.status}`,
      retryable,
      httpStatus: retryable ? 502 : listR.status,
      metadata: { upstream_status: listR.status },
    });
    return toolError({
      error: `gmail_list_${listR.status}`,
      hint: retryable
        ? "Gmail a renvoyé une erreur transitoire. Réessayable."
        : "Gmail a refusé la requête (auth/permissions). Vérifie le connecteur.",
      status: retryable ? 502 : listR.status,
      retryable,
      detail,
    });
  }
  const listJ = await listR.json();
  const messages = (listJ.messages || []) as { id: string; threadId: string }[];
  if (messages.length === 0) {
    tracer.success(
      { count: 0 },
      { account: tok.account_email, unread_only: unreadOnly, empty: true },
    );
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

  tracer.success(
    { count: items.length },
    { account: tok.account_email, max, unread_only: unreadOnly },
  );
  return NextResponse.json({
    account: tok.account_email,
    count: items.length,
    items,
    query: q,
  });
}
