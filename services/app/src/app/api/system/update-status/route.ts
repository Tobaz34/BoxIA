/**
 * GET /api/system/update-status — état courant d'une mise à jour en cours.
 *
 * Lit /data/.update-status écrit par tools/update-watcher.sh côté hôte.
 * Si le fichier est absent : on est idle (aucune MAJ en cours).
 *
 * Session requise : l'admin polle pendant la mise à jour, et un user
 * lambda voit un banner "Mise à jour en cours". Les détails sensibles
 * (log_tail avec chemins/erreurs, requested_by) ne sont renvoyés qu'aux
 * admins — un user lambda ne reçoit que l'état.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_PATH = "/data/.update-status";

interface UpdateStatus {
  state: "idle" | "requested" | "running" | "done" | "failed";
  step?: string;
  message?: string;
  requested_at?: string;
  requested_by?: string;
  started_at?: string;
  finished_at?: string;
  branch?: string;
  exit_code?: number;
  log_tail?: string[];
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = !!(session.user as { isAdmin?: boolean }).isAdmin;
  try {
    const raw = await fs.readFile(STATUS_PATH, "utf-8");
    const status: UpdateStatus = JSON.parse(raw);
    // Auto-purge : si le statut "done" date de >2 min, on retourne idle
    // pour que l'UI revienne à l'état neutre.
    if (status.state === "done" || status.state === "failed") {
      const finished = status.finished_at ? Date.parse(status.finished_at) : 0;
      if (finished && Date.now() - finished > 120_000) {
        return NextResponse.json({ state: "idle" } satisfies UpdateStatus);
      }
    }
    if (!isAdmin) {
      // User lambda : juste de quoi afficher le banner, pas les logs.
      return NextResponse.json({
        state: status.state,
        step: status.step,
        started_at: status.started_at,
        finished_at: status.finished_at,
      } satisfies UpdateStatus);
    }
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ state: "idle" } satisfies UpdateStatus);
  }
}
