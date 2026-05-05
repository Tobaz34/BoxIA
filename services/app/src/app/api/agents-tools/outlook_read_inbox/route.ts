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
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError } from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "outlook_read_inbox", req });

  const url = new URL(req.url);
  const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 20)));
  const unreadOnly = url.searchParams.get("unread") === "1";

  const tok = await getToolToken("microsoft", "outlook-graph");
  if (!tok.ok) {
    tracer.failure({
      errorCode: tok.body.error,
      retryable: false,
      httpStatus: tok.status,
      metadata: { stage: "get_tool_token" },
    });
    return toolError({
      error: tok.body.error,
      hint: tok.body.hint || "Connecteur Microsoft non disponible.",
      status: tok.status,
      retryable: false,
    });
  }

  const filter = unreadOnly ? "&$filter=isRead eq false" : "";
  const select = "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,flag";
  const graphUrl =
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages` +
    `?$top=${max}&$select=${select}&$orderby=receivedDateTime desc${filter}`;

  const r = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    const retryable = r.status === 429 || r.status === 408 || r.status >= 500;
    tracer.failure({
      errorCode: `graph_inbox_${r.status}`,
      retryable,
      httpStatus: retryable ? 502 : r.status,
      metadata: { upstream_status: r.status },
    });
    return toolError({
      error: `graph_inbox_${r.status}`,
      hint: retryable
        ? "Microsoft Graph a renvoyé une erreur transitoire. Réessayable."
        : "Microsoft Graph a refusé la requête (auth/permissions). Vérifie le connecteur.",
      status: retryable ? 502 : r.status,
      retryable,
      detail,
    });
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

  tracer.success(
    { count: items.length },
    { account: tok.account_email, max, unread_only: unreadOnly },
  );
  return NextResponse.json({
    account: tok.account_email,
    count: items.length,
    items,
    filter: unreadOnly ? "unread only" : "all",
  });
}
