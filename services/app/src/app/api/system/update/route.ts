/**
 * POST /api/system/update — déclenche une mise à jour de l'AI Box.
 *
 * Mécanique : écrit un flag /data/.update-requested. Un watcher tourne
 * côté hôte (tools/update-watcher.sh, exécuté par clikinfo via systemd
 * timer) qui voit le flag, lance tools/deploy-to-xefia.sh main, et
 * écrit le statut dans /data/.update-status.
 *
 * Le container Next.js n'a PAS le pouvoir de redémarrer le host :
 *   - pas de docker.sock RW
 *   - pas de git ni de l'arbo /srv/ai-stack
 * → la séparation des pouvoirs est intentionnelle (sécu).
 *
 * Admin only (déploiement = action sensible).
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const FLAG_PATH = "/data/.update-requested";
const STATUS_PATH = "/data/.update-status";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Si une mise à jour est déjà en cours, on refuse.
  try {
    const raw = await fs.readFile(STATUS_PATH, "utf-8");
    const cur = JSON.parse(raw);
    if (cur.state === "requested" || cur.state === "running") {
      return NextResponse.json(
        { error: "already_running", state: cur.state },
        { status: 409 },
      );
    }
  } catch {
    // STATUS_PATH absent ou invalide → on peut continuer
  }

  const body = await req.json().catch(() => ({} as { branch?: string }));
  const branch = String((body as { branch?: string }).branch || "main").replace(/[^a-zA-Z0-9._\-/]/g, "");
  if (!branch) {
    return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
  }

  const flag = {
    requested_at: new Date().toISOString(),
    requested_by: session.user.email,
    branch,
  };
  await fs.mkdir(path.dirname(FLAG_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(FLAG_PATH, JSON.stringify(flag, null, 2) + "\n", "utf-8");

  // On écrit aussi un status initial pour que le polling de l'UI ait un état
  // tout de suite, sans attendre que le watcher (poll 5s) prenne la main.
  const initialStatus = {
    state: "requested" as const,
    step: "waiting_for_watcher",
    message: "Demande enregistrée, en attente du watcher hôte (≤5 s)",
    requested_at: flag.requested_at,
    requested_by: session.user.email,
    branch,
  };
  await fs.writeFile(STATUS_PATH, JSON.stringify(initialStatus, null, 2) + "\n", "utf-8");

  await logAction("settings.update", `system_update_requested:${branch}`, {
    actor: session.user.email,
    ip: ipFromHeaders(req.headers),
    branch,
  });

  return NextResponse.json({ ok: true, ...initialStatus }, { status: 202 });
}
