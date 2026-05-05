/**
 * GET /api/agents-tools/outlook_get_message?id=<message_id>
 *
 * Lit le contenu complet d'un message Outlook (corps texte + attachments).
 * Diff avec Gmail get_thread : Graph retourne 1 message à la fois (pas
 * de notion de thread aussi forte). Pour avoir un thread complet, on
 * filtrerait par conversationId mais on garde simple ici : 1 msg = 1 call.
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken, apiError } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 50_000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) {
    return NextResponse.json({ error: "missing_id", hint: "?id=<message_id>" }, { status: 400 });
  }

  const tok = await getToolToken("microsoft", "outlook-graph");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  const r = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}` +
    `?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,hasAttachments`,
    { headers: { Authorization: `Bearer ${tok.token}` } },
  );
  if (!r.ok) {
    return apiError(r.status, `graph_msg_${r.status}`, await r.text().catch(() => ""));
  }
  const m = await r.json();

  let body = "";
  if (m.body?.contentType === "html") {
    body = stripHtml(m.body.content || "");
  } else {
    body = m.body?.content || "";
  }
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + "\n\n[…tronqué]";
  }

  let attachments: Array<{ name: string; size: number; type: string }> = [];
  if (m.hasAttachments) {
    try {
      const attR = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/attachments?$select=name,size,contentType`,
        { headers: { Authorization: `Bearer ${tok.token}` } },
      );
      if (attR.ok) {
        const attJ = await attR.json();
        attachments = (attJ.value || []).map((a: { name: string; size: number; contentType: string }) => ({
          name: a.name,
          size: a.size,
          type: a.contentType,
        }));
      }
    } catch { /* non bloquant */ }
  }

  return NextResponse.json({
    account: tok.account_email,
    id: m.id,
    subject: m.subject || "(sans objet)",
    from: m.from?.emailAddress?.address || "?",
    to: (m.toRecipients || []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
    cc: (m.ccRecipients || []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
    date: m.receivedDateTime,
    body_text: body,
    attachments,
  });
}
