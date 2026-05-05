/**
 * GET /api/system/services-versions/update-status
 *
 * Lit /data/.service-update-status (écrit par le watcher hôte) et le
 * renvoie tel quel. Polling depuis l'UI ServicesVersionsCard pendant
 * une MAJ en cours.
 *
 * États possibles (cf update-watcher.sh) :
 *   - requested   : flag écrit, watcher pas encore réveillé
 *   - running     : update-service-version.sh en cours
 *   - done        : MAJ réussie + smoke OK
 *   - rolled_back : pull/smoke KO → ancienne version restaurée
 *   - failed      : code de retour inattendu (intervention manuelle)
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_PATH = "/data/.service-update-status";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const raw = await fs.readFile(STATUS_PATH, "utf-8");
    const status = JSON.parse(raw);
    return NextResponse.json(status);
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") {
      return NextResponse.json({ state: "idle" });
    }
    return NextResponse.json(
      { state: "unknown", error: (e as Error).message },
      { status: 500 },
    );
  }
}
