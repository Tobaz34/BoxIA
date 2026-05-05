/**
 * GET /api/rag/disk-usage
 *
 * Renvoie la taille disque consommée par chaque collection Qdrant + le
 * total. La data brute vient d'un `du -sb` exec dans le container
 * aibox-qdrant (la collection storage est sous /qdrant/storage/collections).
 *
 * Réponse :
 *   {
 *     total_bytes: 1234567,
 *     collections: [{ name, bytes }, ...],
 *     server_total_bytes: 9876543210, // df sur /qdrant/storage entier
 *   }
 *
 * Utilise Docker Engine API via UDS pour exec dans le container Qdrant
 * (déjà mounté en RO côté aibox-app pour /api/connectors/sync-status).
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import http from "node:http";

export const dynamic = "force-dynamic";

const DOCKER_SOCK = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const QDRANT_CONTAINER = "aibox-qdrant";

interface ExecCreateResp { Id: string }

function dockerRequest(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; rawBuf: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: "docker",
      Accept: "application/json",
    };
    let bodyBuf: Buffer | null = null;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), "utf-8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(bodyBuf.length);
    }
    const req = http.request(
      { socketPath: DOCKER_SOCK, path, method: opts.method || "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode || 0,
          rawBuf: Buffer.concat(chunks),
        }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("docker_timeout")));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Exécute une commande dans un container et renvoie stdout (parsing du
 * stream multiplexé Docker : 8 bytes header + payload, cf
 * sync-status/route.ts pour le même pattern).
 */
async function dockerExec(container: string, cmd: string[]): Promise<string> {
  // 1. Create exec
  const createRes = await dockerRequest(
    `/containers/${container}/exec`,
    {
      method: "POST",
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: cmd,
      },
    },
  );
  if (createRes.status !== 201) {
    throw new Error(`exec_create_${createRes.status}: ${createRes.rawBuf.toString("utf-8").slice(0, 200)}`);
  }
  const { Id: execId } = JSON.parse(createRes.rawBuf.toString("utf-8")) as ExecCreateResp;

  // 2. Start exec
  const startRes = await dockerRequest(
    `/exec/${execId}/start`,
    { method: "POST", body: { Detach: false, Tty: false } },
  );
  if (startRes.status !== 200) {
    throw new Error(`exec_start_${startRes.status}`);
  }

  // 3. Démultiplexage du stream (header 8 bytes : stream(1) + 0,0,0 + size_be32)
  const buf = startRes.rawBuf;
  let offset = 0;
  let stdout = "";
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    if (stream > 2 || buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) {
      // Pas un header valide → reste en raw
      stdout += buf.slice(offset).toString("utf-8");
      break;
    }
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    if (stream === 1) {
      // 1 = stdout, 2 = stderr (on ignore stderr ici)
      stdout += buf.slice(offset, offset + size).toString("utf-8");
    }
    offset += size;
  }
  return stdout;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let perCol: Array<{ name: string; bytes: number }> = [];
  let totalBytes = 0;
  let serverTotalBytes: number | null = null;
  let serverFreeBytes: number | null = null;
  let error: string | null = null;

  // Per-collection : `du -sb /qdrant/storage/collections/*` retourne une
  // ligne par sous-dossier avec `<bytes>\t<path>`.
  try {
    const out = await dockerExec(QDRANT_CONTAINER, [
      "sh", "-c", "du -sb /qdrant/storage/collections/* 2>/dev/null || true",
    ]);
    for (const line of out.split("\n")) {
      const m = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const bytes = parseInt(m[1], 10);
      const fullPath = m[2];
      const name = fullPath.split("/").pop() || fullPath;
      perCol.push({ name, bytes });
      totalBytes += bytes;
    }
    perCol.sort((a, b) => b.bytes - a.bytes);
  } catch (e) {
    error = `du_failed: ${(e as Error).message}`;
  }

  // Server total: `df /qdrant/storage` pour avoir taille totale du
  // volume + free space.
  try {
    const out = await dockerExec(QDRANT_CONTAINER, [
      "sh", "-c", "df --output=size,avail -B 1 /qdrant/storage 2>/dev/null | tail -1",
    ]);
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out.trim());
    if (m) {
      serverTotalBytes = parseInt(m[1], 10);
      serverFreeBytes = parseInt(m[2], 10);
    }
  } catch {
    // best-effort
  }

  return NextResponse.json({
    total_bytes: totalBytes,
    collections: perCol,
    server_total_bytes: serverTotalBytes,
    server_free_bytes: serverFreeBytes,
    error,
  });
}
