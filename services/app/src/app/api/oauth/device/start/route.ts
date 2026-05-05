/**
 * POST /api/oauth/device/start
 * Body: { provider: "google"|"microsoft", connector_slug: string, scopes?: string[] }
 *
 * Admin only. Initie un Device Flow OAuth contre le provider et retourne
 * le user_code + verification_url à afficher dans la modal UI.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { startDeviceFlow } from "@/lib/oauth-device-flow";
import type { OAuthProviderId } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as {
    provider?: string;
    connector_slug?: string;
    scopes?: string[];
  };
  if (!body.provider || !body.connector_slug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.provider !== "google" && body.provider !== "microsoft") {
    return NextResponse.json({ error: "unsupported_provider" }, { status: 400 });
  }
  try {
    const result = await startDeviceFlow(
      body.provider as OAuthProviderId,
      body.connector_slug,
      session.user.email,
      body.scopes,
    );
    await logAction("settings.update", `oauth_device_started:${body.provider}:${body.connector_slug}`, {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      request_id: result.request_id,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
