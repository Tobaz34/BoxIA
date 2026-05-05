/**
 * GET /api/agents-tools/outlook_read_inbox?max=20&unread=1
 *
 * Tool Dify pour les agents BoxIA. Retourne les derniers emails de la
 * boîte de réception Outlook/Microsoft 365 du user connecté via OAuth
 * Microsoft (slug : outlook-graph).
 *
 * Pattern miroir de gmail_read_inbox côté Microsoft Graph
 * /me/mailFolders/inbox/messages.
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

  const tok = await getToolToken("microsoft", "outlook-graph");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  const filter = unreadOnly ? "&$filter=isRead eq false" : "";
  const select = "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,flag";
  const graphUrl =
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages` +
    `?$top=${max}&$select=${select}&$orderby=receivedDateTime desc${filter}`;

  const r = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!r.ok) {
    return apiError(r.status, `graph_inbox_${r.status}`, await r.text().catch(() => ""));
  }
  const j = await r.json();
  const items = (j.value || []).map((m: {
    id: string; conversationId: string; subject?: string;
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string } }>;
    receivedDateTime?: string; bodyPreview?: string; isRead?: boolean;
    hasAttachments?: boolean; flag?: { flagStatus?: string };
  }) => ({
    id: m.id,
    conversation_id: m.conversationId,
    from: m.from?.emailAddress?.address || m.from?.emailAddress?.name || "?",
    from_name: m.from?.emailAddress?.name,
    to: (m.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(", "),
    subject: m.subject || "(sans objet)",
    date: m.receivedDateTime,
    snippet: m.bodyPreview || "",
    unread: !m.isRead,
    has_attachments: !!m.hasAttachments,
    flagged: m.flag?.flagStatus === "flagged",
  }));

  return NextResponse.json({
    account: tok.account_email,
    count: items.length,
    items,
    filter: unreadOnly ? "unread only" : "all",
  });
}
