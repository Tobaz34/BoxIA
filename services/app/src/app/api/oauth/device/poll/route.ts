/**
 * POST /api/oauth/device/poll
 * Body: { request_id: string }
 *
 * Admin only. Poll le token endpoint du provider. Retourne pending,
 * slow_down, success ou error. L'UI rappelle toutes les `interval`
 * secondes jusqu'à success/error/expiration.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { pollDeviceFlow } from "@/lib/oauth-device-flow";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { request_id?: string };
  if (!body.request_id) {
    return NextResponse.json({ error: "missing_request_id" }, { status: 400 });
  }
  const result = await pollDeviceFlow(body.request_id);
  // On ne renvoie PAS le access_token au client : le caller doit
  // utiliser /api/oauth/connections pour lister les connexions, sans
  // jamais voir le token brut.
  if (result.state === "success") {
    await logAction(
      "settings.update",
      `oauth_device_connected:${result.connection.provider_id}:${result.connection.connector_slug}`,
      {
        actor: session.user.email,
        ip: ipFromHeaders(req),
        account_email: result.connection.account_email,
      },
    );
    return NextResponse.json({
      state: "success",
      connection: {
        id: result.connection.id,
        provider_id: result.connection.provider_id,
        connector_slug: result.connection.connector_slug,
        account_email: result.connection.account_email,
        account_name: result.connection.account_name,
        scopes: result.connection.scopes,
        connected_at: result.connection.connected_at,
        expires_at: result.connection.expires_at,
      },
    });
  }
  return NextResponse.json(result);
}
