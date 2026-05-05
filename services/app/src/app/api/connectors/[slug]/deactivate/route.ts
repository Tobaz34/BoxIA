/** POST /api/connectors/[slug]/deactivate — admin only. */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deactivateConnector } from "@/lib/connectors-state";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import {
  deleteCredentialForConnector,
  bridgedConnectorSlugs,
} from "@/lib/n8n-credentials";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await params;
  await deactivateConnector(slug);
  await logAction("connector.deactivate", slug, undefined, ipFromHeaders(req));

  // Best-effort : supprime la credential n8n associée si elle existait.
  // Les workflows qui l'utilisaient erreront au prochain run (auth manquante)
  // — comportement attendu : désactiver le connecteur = ne plus laisser tourner.
  let n8n_credential_deleted = false;
  if (bridgedConnectorSlugs().includes(slug)) {
    try {
      n8n_credential_deleted = await deleteCredentialForConnector(slug);
    } catch (e) {
      console.warn(`[connectors/${slug}/deactivate] n8n credential delete failed:`, e);
    }
  }

  return NextResponse.json({ ok: true, n8n_credential_deleted });
}
