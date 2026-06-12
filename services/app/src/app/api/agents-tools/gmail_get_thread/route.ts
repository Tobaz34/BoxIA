/**
 * GET /api/agents-tools/gmail_get_thread?id=<thread_id>
 *
 * Lit le contenu complet d'un thread Gmail (messages + corps texte).
 * Utilisé par l'agent quand l'utilisateur dit "résume ce thread" ou
 * "que dit-il dans son dernier mail ?".
 *
 * Réponse :
 *   { account, thread_id, subject, messages: [
 *       { id, from, to, date, body_text, attachments_summary }
 *     ]}
 *
 * NB : on parse le body_text en best-effort (text/plain ou strip HTML).
 * On cap à 50k chars pour ne pas exploser le contexte LLM.
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken, apiError } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 50_000;

function decodeBase64Url(s: string): string {
  try {
    const b = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  filename?: string;
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function extractBody(part: GmailPart): string {
  // Préfère text/plain si dispo, sinon strip HTML
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    // Cherche text/plain en priorité
    for (const p of part.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) {
        return decodeBase64Url(p.body.data);
      }
    }
    // Sinon text/html stripé
    for (const p of part.parts) {
      if (p.mimeType === "text/html" && p.body?.data) {
        return stripHtml(decodeBase64Url(p.body.data));
      }
    }
    // Récursif sur multipart/*
    for (const p of part.parts) {
      const sub = extractBody(p);
      if (sub) return sub;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }
  return "";
}

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const threadId = (url.searchParams.get("id") || "").trim();
  if (!threadId) {
    return NextResponse.json({ error: "missing_id", hint: "?id=<thread_id>" }, { status: 400 });
  }

  const tok = await getToolToken("google", "gmail");
  if (!tok.ok) return NextResponse.json(tok.body, { status: tok.status });

  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    { headers: { Authorization: `Bearer ${tok.token}` } },
  );
  if (!r.ok) {
    return apiError(r.status, `gmail_thread_${r.status}`, await r.text().catch(() => ""));
  }
  const t = await r.json();
  const messages = (t.messages || []) as Array<{ id: string; payload: GmailPart; internalDate: string }>;
  const items = messages.map((m) => {
    const headers: Record<string, string> = {};
    for (const h of m.payload?.headers || []) {
      headers[(h.name || "").toLowerCase()] = h.value;
    }
    let bodyText = extractBody(m.payload);
    if (bodyText.length > MAX_BODY_CHARS) {
      bodyText = bodyText.slice(0, MAX_BODY_CHARS) + "\n\n[…tronqué]";
    }
    const attachments = (m.payload?.parts || [])
      .filter((p) => p.filename && p.filename.trim())
      .map((p) => ({ filename: p.filename, mime: p.mimeType, size: p.body?.size }));
    return {
      id: m.id,
      from: headers.from || "?",
      to: headers.to || "?",
      cc: headers.cc,
      date: headers.date || "?",
      body_text: bodyText,
      attachments,
    };
  });
  // Subject = celui du 1er msg
  const firstHeaders = messages[0]?.payload?.headers || [];
  const subject = (firstHeaders.find((h) => h.name?.toLowerCase() === "subject")?.value) || "(sans objet)";

  return NextResponse.json({
    account: tok.account_email,
    thread_id: threadId,
    subject,
    message_count: items.length,
    messages: items,
  });
}
