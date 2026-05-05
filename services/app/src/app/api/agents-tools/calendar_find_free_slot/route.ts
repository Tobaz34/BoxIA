/**
 * GET /api/agents-tools/calendar_find_free_slot?duration=60&within_days=7&working_hours=9-18&provider=google
 *
 * Cherche un créneau libre de N minutes dans les prochains jours, en
 * respectant les horaires de travail. Algorithme :
 *   1. List events des N prochains jours (calendar_today helper)
 *   2. Pour chaque jour ouvré (lundi-vendredi par défaut), génère les
 *      créneaux libres de >= duration entre working_hours
 *   3. Retourne les 5 premiers
 *
 * Provider = "google" | "microsoft" | "any" (default = any, agrège les
 * occupations des 2 calendriers connectés pour donner la vue libre globale).
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { getToolToken } from "@/lib/connector-tool-helpers";
import { toolError } from "@/lib/tool-errors";

export const dynamic = "force-dynamic";

interface Busy { start: Date; end: Date; }

async function fetchBusy(provider: "google" | "microsoft", token: string, fromIso: string, toIso: string): Promise<Busy[]> {
  if (provider === "google") {
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: "primary" }] }),
    });
    if (!r.ok) throw new Error(`google_freebusy_${r.status}`);
    const j = await r.json();
    const busy = j.calendars?.primary?.busy || [];
    return busy.map((b: { start: string; end: string }) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
  // microsoft
  const r = await fetch("https://graph.microsoft.com/v1.0/me/calendar/getSchedule", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      schedules: ["me"],
      startTime: { dateTime: fromIso, timeZone: "UTC" },
      endTime: { dateTime: toIso, timeZone: "UTC" },
      availabilityViewInterval: 15,
    }),
  });
  if (!r.ok) throw new Error(`microsoft_freebusy_${r.status}`);
  const j = await r.json();
  const slots = j.value?.[0]?.scheduleItems || [];
  return slots
    .filter((s: { status: string }) => s.status === "busy" || s.status === "tentative" || s.status === "oof")
    .map((s: { start: { dateTime: string }; end: { dateTime: string } }) => ({
      start: new Date(s.start.dateTime),
      end: new Date(s.end.dateTime),
    }));
}

function parseHours(s: string): [number, number] {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return [9, 18];
  return [Math.max(0, Math.min(23, parseInt(m[1], 10))), Math.max(0, Math.min(24, parseInt(m[2], 10)))];
}

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const duration = Math.max(15, Math.min(480, Number(url.searchParams.get("duration") ?? 60)));
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("within_days") ?? 7)));
  const [hStart, hEnd] = parseHours(url.searchParams.get("working_hours") || "9-18");
  const wanted = (url.searchParams.get("provider") || "any").toLowerCase();

  // Collect busy intervals from selected providers
  const tryProviders: Array<["google" | "microsoft", string]> = wanted === "google"
    ? [["google", "google-calendar"]]
    : wanted === "microsoft"
      ? [["microsoft", "outlook-calendar"]]
      : [["google", "google-calendar"], ["microsoft", "outlook-calendar"]];

  const allBusy: Busy[] = [];
  const sources: Array<{ provider: string; account?: string; busy_count: number }> = [];
  const errors: Array<{ provider: string; error: string }> = [];

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + days);

  for (const [prov, slug] of tryProviders) {
    const tok = await getToolToken(prov, slug);
    if (!tok.ok) { errors.push({ provider: prov, error: tok.body.error }); continue; }
    try {
      const busy = await fetchBusy(prov, tok.token, now.toISOString(), horizon.toISOString());
      allBusy.push(...busy);
      sources.push({ provider: prov, account: tok.account_email, busy_count: busy.length });
    } catch (e) {
      errors.push({ provider: prov, error: String(e instanceof Error ? e.message : e) });
    }
  }

  if (sources.length === 0) {
    return toolError({
      error: "no_calendar_connected",
      hint: "Connectez Google Calendar ou Outlook Calendar dans /connectors.",
      status: 404,
      retryable: false,
    });
  }

  // Merge & sort busy intervals
  allBusy.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Busy[] = [];
  for (const b of allBusy) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }

  // Generate free slots day-by-day, respect working hours, mon-fri
  const slots: Array<{ start: string; end: string; duration_minutes: number; weekday: string }> = [];
  const targetMs = duration * 60_000;
  const days_fr = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  for (let d = 0; d < days && slots.length < 5; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const dayStart = new Date(day);
    dayStart.setHours(hStart, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(hEnd, 0, 0, 0);
    let cursor = d === 0 && now > dayStart ? new Date(Math.max(now.getTime(), dayStart.getTime())) : dayStart;
    // Iterate busy chunks within the day
    for (const b of merged) {
      if (b.end <= cursor) continue;
      if (b.start >= dayEnd) break;
      if (b.start.getTime() - cursor.getTime() >= targetMs) {
        const slotEnd = new Date(cursor.getTime() + targetMs);
        slots.push({
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
          duration_minutes: duration,
          weekday: days_fr[dow],
        });
        if (slots.length >= 5) break;
      }
      if (b.end > cursor) cursor = b.end > dayEnd ? dayEnd : b.end;
    }
    if (slots.length < 5 && dayEnd.getTime() - cursor.getTime() >= targetMs) {
      const slotEnd = new Date(cursor.getTime() + targetMs);
      slots.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
        duration_minutes: duration,
        weekday: days_fr[dow],
      });
    }
  }

  return NextResponse.json({
    duration_minutes: duration,
    within_days: days,
    working_hours: `${hStart}-${hEnd}`,
    sources,
    errors: errors.length > 0 ? errors : undefined,
    free_slots_count: slots.length,
    free_slots: slots,
  });
}
