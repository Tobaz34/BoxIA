/**
 * GET /api/dify/workflows — liste les apps Dify installées de mode
 * "workflow" (pipelines déterministes : résume PDF, transcris audio…).
 *
 * Filtré par rôle de l'utilisateur (allowed_roles côté installed-agents).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listInstalledAgents } from "@/lib/installed-agents";
import { roleFromGroups } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const groups = (session.user as { groups?: string[] }).groups || [];
  const role = roleFromGroups(groups);

  const all = await listInstalledAgents();
  const workflows = all
    .filter((a) => a.mode === "workflow" || a.mode === "advanced-chat")
    .filter((a) => {
      if (!a.allowed_roles || a.allowed_roles.length === 0) return true;
      return a.allowed_roles.includes(role);
    })
    .map((a) => ({
      slug: a.slug,
      app_id: a.app_id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      icon_background: a.icon_background,
      mode: a.mode,
      installed_at: a.installed_at,
      // PAS d'api_key ici (sécurité — exposée côté client)
    }));
  return NextResponse.json({ workflows });
}
