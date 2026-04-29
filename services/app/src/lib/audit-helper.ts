/**
 * Helpers de logging audit qui s'auto-référencent à la session NextAuth
 * en cours. Permet d'écrire `await logAction("connector.activate", slug)`
 * dans une route sans recopier 5 lignes de boilerplate.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAudit, type AuditAction } from "@/lib/app-audit";
import { roleFromGroups } from "@/lib/agents";

export async function logAction(
  action: AuditAction,
  target?: string,
  details?: Record<string, unknown>,
  clientIp?: string | null,
): Promise<void> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return;
  const groups = (session.user as { groups?: string[] }).groups || [];
  await logAudit({
    ts: Date.now(),
    actor: session.user.email,
    actor_role: roleFromGroups(groups),
    action,
    target,
    details,
    client_ip: clientIp ?? null,
  });
}

/** Récupère la première IP visible depuis les headers (X-Forwarded-For
 *  prioritaire, fallback X-Real-IP). Renvoie null si introuvable. */
export function ipFromHeaders(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}
