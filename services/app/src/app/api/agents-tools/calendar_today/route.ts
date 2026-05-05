/**
 * GET /api/agents-tools/calendar_today?provider=google&days=1
 *
 * Tool Dify : retourne les événements du calendrier pour les N
 * prochains jours (default 1 = aujourd'hui).
 *
 * provider = "google" | "microsoft" — l'agent doit indiquer lequel.
 * Si non précisé, on tente Google d'abord puis Microsoft en fallback
 * (selon ce qui est connecté).
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError } from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  attendees?: string[];
  organizer?: string;
  description_snippet?: string;
  link?: string;
}

async function listGoogle(token: string, days: number, max: number): Promise<CalEvent[]> {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(now.toISOString())}` +
    `&timeMax=${encodeURIComponent(end.toISOString())}` +
    `&singleEvents=true&orderBy=startTime&maxResults=${max}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`google_${r.status}`);
  const j = await r.json();
  return (j.items || []).map((e: {
    id: string; summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    attendees?: Array<{ email?: string }>;
    organizer?: { email?: string };
    description?: string; htmlLink?: string;
  }) => ({
    id: e.id,
    title: e.summary || "(sans titre)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    all_day: !e.start?.dateTime,
    location: e.location,
    attendees: (e.attendees || []).map((a) => a.email).filter(Boolean) as string[],
    organizer: e.organizer?.email,
    description_snippet: (e.description || "").slice(0, 200),
    link: e.htmlLink,
  }));
}

async function listMicrosoft(token: string, days: number, max: number): Promise<CalEvent[]> {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  const url =
    `https://graph.microsoft.com/v1.0/me/calendarView` +
    `?startDateTime=${encodeURIComponent(now.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$select=id,subject,start,end,isAllDay,location,attendees,organizer,bodyPreview,webLink` +
    `&$orderby=start/dateTime&$top=${max}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!r.ok) throw new Error(`microsoft_${r.status}`);
  const j = await r.json();
  return (j.value || []).map((e: {
    id: string; subject?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    isAllDay?: boolean;
    location?: { displayName?: string };
    attendees?: Array<{ emailAddress?: { address?: string } }>;
    organizer?: { emailAddress?: { address?: string } };
    bodyPreview?: string; webLink?: string;
  }) => ({
    id: e.id,
    title: e.subject || "(sans titre)",
    start: e.start?.dateTime || "",
    end: e.end?.dateTime || "",
    all_day: !!e.isAllDay,
    location: e.location?.displayName,
    attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean) as string[],
    organizer: e.organizer?.emailAddress?.address,
    description_snippet: (e.bodyPreview || "").slice(0, 200),
    link: e.webLink,
  }));
}

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "calendar_today", req });

  const url = new URL(req.url);
  const days = Math.min(31, Math.max(1, Number(url.searchParams.get("days") ?? 1)));
  const max = Math.min(100, Math.max(1, Number(url.searchParams.get("max") ?? 50)));
  const wanted = (url.searchParams.get("provider") || "").toLowerCase();

  const tryProviders: Array<["google" | "microsoft", string]> = wanted === "google"
    ? [["google", "google-calendar"]]
    : wanted === "microsoft"
      ? [["microsoft", "outlook-calendar"]]
      : [["google", "google-calendar"], ["microsoft", "outlook-calendar"]];

  const results: Array<{ provider: string; events: CalEvent[]; account?: string }> = [];
  const errors: Array<{ provider: string; error: string }> = [];
  for (const [prov, slug] of tryProviders) {
    const tok = await getToolToken(prov, slug);
    if (!tok.ok) {
      errors.push({ provider: prov, error: tok.body.error });
      continue;
    }
    try {
      const events = prov === "google"
        ? await listGoogle(tok.token, days, max)
        : await listMicrosoft(tok.token, days, max);
      results.push({ provider: prov, account: tok.account_email, events });
    } catch (e) {
      errors.push({ provider: prov, error: String(e instanceof Error ? e.message : e) });
    }
  }

  if (results.length === 0) {
    tracer.failure({
      errorCode: "no_calendar_connected",
      retryable: false,
      httpStatus: 404,
      metadata: { errors_count: errors.length },
    });
    return toolError({
      error: "no_calendar_connected",
      hint: "Connectez Google Calendar ou Outlook Calendar via /connectors.",
      status: 404,
      retryable: false,
      detail: `errors=${JSON.stringify(errors).slice(0, 300)}`,
    });
  }

  // Concat tous les events de tous les providers, triés par start
  const all = results.flatMap((r) => r.events.map((e) => ({ ...e, provider: r.provider })));
  all.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

  tracer.success(
    {
      count: all.length,
      providers: results.map((r) => r.provider),
    },
    { days, max, errors_count: errors.length },
  );
  return NextResponse.json({
    days_ahead: days,
    sources: results.map((r) => ({ provider: r.provider, account: r.account, count: r.events.length })),
    errors: errors.length > 0 ? errors : undefined,
    count: all.length,
    events: all,
  });
}
