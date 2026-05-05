/**
 * POST /api/system/services-versions/update
 * body: { slug: "dify", target_version: "1.14.0" }
 *
 * Demande au watcher hôte (tools/update-watcher.sh) de :
 *   1. backup .env
 *   2. patch la VERSION du service ciblé
 *   3. docker compose pull + recreate
 *   4. smoke test
 *   5. rollback automatique si KO
 *
 * Mécanique : écrit /data/.service-update-requested. Le watcher polling 5s
 * voit le flag, exec tools/update-service-version.sh <slug> <version>,
 * publie la progression dans /data/.service-update-status.
 *
 * Le container aibox-app n'a PAS l'autorité (pas de docker.sock RW au
 * niveau VM, pas d'accès .env, pas d'accès aux composes /srv/ai-stack).
 * → flag-based handoff (même pattern que /api/system/update).
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const FLAG_PATH = "/data/.service-update-requested";
const STATUS_PATH = "/data/.service-update-status";

const ALLOWED_SLUGS = new Set([
  "dify", "qdrant", "authentik", "n8n", "ollama", "langfuse",
]);

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Si une MAJ service est déjà en cours, refuse (concurrent updates =
  // .env corrompu si 2 sed en parallèle).
  try {
    const raw = await fs.readFile(STATUS_PATH, "utf-8");
    const cur = JSON.parse(raw);
    if (cur.state === "running") {
      return NextResponse.json(
        { error: "already_running", current: cur },
        { status: 409 },
      );
    }
  } catch { /* status absent → OK */ }

  const body = (await req.json().catch(() => ({}))) as {
    slug?: string;
    target_version?: string;
  };
  const slug = String(body.slug || "");
  const targetVersion = String(body.target_version || "");

  if (!slug || !ALLOWED_SLUGS.has(slug)) {
    return NextResponse.json(
      { error: "invalid_slug", allowed: Array.from(ALLOWED_SLUGS) },
      { status: 400 },
    );
  }
  // Sanity check : version safe (prévient l'injection shell même si le
  // script side-côté valide aussi).
  if (!/^[v]?[0-9A-Za-z._-]+$/.test(targetVersion)) {
    return NextResponse.json(
      { error: "invalid_target_version", hint: "Format attendu : 1.14.0 ou v1.14.0" },
      { status: 400 },
    );
  }

  const flag = {
    slug,
    target_version: targetVersion,
    requested_at: new Date().toISOString(),
    requested_by: session.user.email,
  };
  await fs.mkdir(path.dirname(FLAG_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(FLAG_PATH, JSON.stringify(flag, null, 2) + "\n", "utf-8");

  // Status initial pour que le polling UI ait un état immédiat
  const initialStatus = {
    state: "requested" as const,
    message: `Demande enregistrée pour ${slug} → ${targetVersion}, en attente du watcher (≤5 s)…`,
    slug,
    target: targetVersion,
    requested_at: flag.requested_at,
    requested_by: session.user.email,
  };
  await fs.writeFile(
    STATUS_PATH,
    JSON.stringify(initialStatus, null, 2) + "\n",
    "utf-8",
  );

  await logAction("settings.update", `service_update_requested:${slug}:${targetVersion}`, {
    actor: session.user.email,
    ip: ipFromHeaders(req),
    slug,
    target_version: targetVersion,
  });

  return NextResponse.json({ ok: true, ...initialStatus }, { status: 202 });
}
