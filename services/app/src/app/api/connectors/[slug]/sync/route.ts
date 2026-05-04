/**
 * POST /api/connectors/[slug]/sync — déclenche un sync immédiat.
 *
 * Comportement :
 *   - Pour les connecteurs RAG OAuth (google-drive, onedrive,
 *     sharepoint-online) : redémarre le worker Docker via UDS Engine API,
 *     ce qui force un sync au boot du container (cf worker.py main loop).
 *   - Pour tous les autres : marque last_sync_at = now (mock V1, le worker
 *     réel n'existe pas encore — ça valide juste l'UX).
 *
 * Côté UI, le polling /api/connectors/sync-status?slug=... voit ensuite
 * le container "running + first cycle" et reflète le progrès.
 *
 * Admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recordSyncStart, recordSyncSuccess } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";
import http from "node:http";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const RAG_WORKERS: Record<string, { container: string }> = {
  "google-drive": { container: "aibox-conn-rag-gdrive" },
  "onedrive": { container: "aibox-conn-rag-msgraph" },
  "sharepoint-online": { container: "aibox-conn-rag-msgraph" },
};

const DOCKER_SOCK = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

function dockerRestart(name: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: `/containers/${name}/restart?t=2`,
        method: "POST",
        headers: { Host: "docker", Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("docker_restart_timeout")));
    req.end();
  });
}

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
  const spec = getConnector(slug);
  if (!spec) {
    return NextResponse.json({ error: "unknown_connector" }, { status: 404 });
  }

  await recordSyncStart(slug);

  // Branche réelle : worker Python à redémarrer
  const w = RAG_WORKERS[slug];
  if (w) {
    let restartResult;
    try {
      restartResult = await dockerRestart(w.container);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // On laisse le sync_start posé (l'UI verra last_error au prochain
      // /api/connectors GET via la lecture de l'état).
      return NextResponse.json(
        {
          error: "docker_restart_failed",
          container: w.container,
          hint: errMsg,
        },
        { status: 502 },
      );
    }
    if (restartResult.status === 404) {
      return NextResponse.json(
        {
          error: "container_not_found",
          container: w.container,
          hint:
            `Le worker ${w.container} n'est pas démarré. ` +
            `Demande à l'admin de lancer tools/start-connector.sh ` +
            `${slug.includes("drive") ? "rag-gdrive" : "rag-msgraph"} --rebuild.`,
        },
        { status: 404 },
      );
    }
    if (restartResult.status !== 204 && restartResult.status !== 200) {
      return NextResponse.json(
        {
          error: "docker_restart_failed",
          container: w.container,
          status: restartResult.status,
        },
        { status: 502 },
      );
    }

    await logAction("connector.sync", `connector_sync_now:${slug}`, {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      slug,
      container: w.container,
    });

    return NextResponse.json({
      ok: true,
      slug,
      container: w.container,
      triggered_at: new Date().toISOString(),
      message: "Worker redémarré, sync en cours.",
    });
  }

  // Branche mock V1 (autres connecteurs sans worker réel) — pas régressé
  await recordSyncSuccess(slug, {
    last_objects_added: 0,
    last_objects_removed: 0,
  });

  return NextResponse.json({
    ok: true,
    note: spec.implStatus !== "implemented"
      ? "Sync simulé. Le worker réel arrivera dans une prochaine version."
      : null,
  });
}
