/**
 * POST /api/connectors/[slug]/activate
 * body: { config: Record<string, string> }
 *
 * Active (ou reconfigure) un connecteur. Admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activateConnector } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import {
  pushCredentialFromConnector,
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
  const isAdmin = (session.user as { isAdmin?: boolean })?.isAdmin;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  const spec = getConnector(slug);
  if (!spec) {
    return NextResponse.json({ error: "unknown_connector" }, { status: 404 });
  }

  let body: { config?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  try {
    const next = await activateConnector(slug, body.config || {});
    await logAction("connector.activate", slug, {
      config_keys: Object.keys(body.config || {}),
      impl_status: spec.implStatus,
    }, ipFromHeaders(req));

    // SharePoint : si l'admin a coché des bibliothèques via le picker,
    // on écrit /data/sharepoint-config.json que le worker rag-msgraph
    // (volume mounté) va lire pour savoir quels drive_ids indexer.
    if (slug === "sharepoint") {
      try {
        const driveIdsRaw = (body.config || {}).drive_ids;
        if (driveIdsRaw) {
          const parsed = JSON.parse(driveIdsRaw);
          const fs = await import("node:fs/promises");
          const path = "/data/sharepoint-config.json";
          await fs.writeFile(
            path,
            JSON.stringify(
              {
                drive_ids: parsed,
                updated_at: new Date().toISOString(),
                updated_by: session.user.email,
              },
              null,
              2,
            ) + "\n",
            "utf-8",
          );
        }
      } catch (e) {
        console.error("[connectors/sharepoint] failed to write config:", e);
      }
    }

    // Best-effort : pour les 3 slugs RAG OAuth, déclenche un restart du
    // container worker (= sync initial). Si le container n'existe pas
    // (pas encore démarré côté admin avec start-connector.sh), on
    // n'échoue pas — l'admin verra le chip "non démarré" et lancera le
    // worker manuellement.
    let initial_sync_triggered = false;
    if (["google-drive", "onedrive", "sharepoint"].includes(slug)) {
      try {
        const http = await import("node:http");
        const container = slug === "google-drive"
          ? "aibox-conn-rag-gdrive"
          : "aibox-conn-rag-msgraph";
        const sock = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
        await new Promise<void>((resolve) => {
          const r = http.request(
            {
              socketPath: sock,
              path: `/containers/${container}/restart?t=2`,
              method: "POST",
              headers: { Host: "docker" },
            },
            (res) => {
              if (res.statusCode === 204 || res.statusCode === 200) {
                initial_sync_triggered = true;
              }
              res.resume();
              resolve();
            },
          );
          r.on("error", () => resolve()); // best-effort, on ne bloque pas
          r.setTimeout(5000, () => { r.destroy(); resolve(); });
          r.end();
        });
      } catch {
        // best-effort, on ignore
      }
    }

    // Best-effort : si ce slug a un mapper de credential n8n (cf.
    // lib/n8n-credentials.ts), pousse les creds dans n8n pour que les
    // workflows marketplace IMAP/SMTP/Slack puissent les réutiliser
    // sans saisie manuelle dans la console n8n.
    let n8n_credential_pushed = false;
    if (bridgedConnectorSlugs().includes(slug)) {
      try {
        const ref = await pushCredentialFromConnector(slug);
        if (ref) n8n_credential_pushed = true;
      } catch (e) {
        console.warn(`[connectors/${slug}/activate] n8n credential push failed:`, e);
      }
    }

    return NextResponse.json({
      ok: true,
      slug: next.slug,
      status: next.status,
      activated_at: next.activated_at,
      impl_status: spec.implStatus,
      initial_sync_triggered,
      n8n_credential_pushed,
      note: spec.implStatus !== "implemented"
        ? "Connecteur enregistré mais le worker n'est pas encore implémenté côté backend. " +
          "La configuration sera utilisée dès que le connecteur sera disponible."
        : null,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: "activation_failed", message: (e as Error).message },
      { status: 400 },
    );
  }
}
