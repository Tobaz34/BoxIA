/**
 * GET  /api/branding         — récupère le branding courant (lecture publique)
 * POST /api/branding         — met à jour (admin only)
 *
 * Persistance : `/data/branding.json` (volume monté).
 * Le branding "live" est appliqué au prochain refresh de la page (lit
 * via `/api/branding` au mount du layout client).
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const BRANDING_FILE = path.join(STATE_DIR, "branding.json");

export const dynamic = "force-dynamic";

export interface Branding {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  footerText?: string;
  clientName?: string;
}

const DEFAULTS: Branding = {
  name: process.env.BRAND_NAME || "AI Box",
  logoUrl: process.env.BRAND_LOGO_URL || "",
  primaryColor: process.env.BRAND_PRIMARY_COLOR || "#3b82f6",
  accentColor: process.env.BRAND_ACCENT_COLOR || "#10b981",
  footerText: process.env.BRAND_FOOTER_TEXT || "",
  clientName: process.env.CLIENT_NAME || "",
};

async function readBranding(): Promise<Branding> {
  try {
    const txt = await fs.readFile(BRANDING_FILE, "utf8");
    const parsed = JSON.parse(txt) as Branding;
    return { ...DEFAULTS, ...parsed };
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") return { ...DEFAULTS };
    return { ...DEFAULTS };
  }
}

async function writeBranding(b: Branding) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch { /* noop */ }
  const tmp = BRANDING_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(b, null, 2), "utf8");
  await fs.rename(tmp, BRANDING_FILE);
}

export async function GET() {
  // Public — l'app a besoin du branding pour le layout (logo, couleurs).
  // On ne renvoie que les champs publics, pas de secrets.
  const b = await readBranding();
  return NextResponse.json(b);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Branding;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Validation simple : couleurs au format hex #rrggbb
  const isHex = (s?: string) =>
    !s || /^#[0-9a-fA-F]{6}$/.test(s);
  if (!isHex(body.primaryColor) || !isHex(body.accentColor)) {
    return NextResponse.json(
      { error: "bad_color", message: "Couleur invalide (format attendu : #rrggbb)" },
      { status: 400 },
    );
  }

  const current = await readBranding();
  const next: Branding = { ...current, ...body };
  await writeBranding(next);
  await logAction("settings.update", "branding", {
    fields: Object.keys(body),
  }, ipFromHeaders(req));
  return NextResponse.json(next);
}
