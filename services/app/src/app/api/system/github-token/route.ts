/**
 * POST   /api/system/github-token — admin-only, sauvegarde un token GitHub
 *                                    fine-grained PAT après validation /user
 * DELETE /api/system/github-token — admin-only, supprime le token stocké
 *
 * Le token n'est jamais retourné par l'API. On ne renvoie que login + scopes
 * en cas de validation OK.
 *
 * Source d'autorité : si .env contient GITHUB_TOKEN, c'est lui qui prime
 * (provisioning > UI override). L'admin verra dans /api/system/github-status
 * que la source est "env" et la suppression UI ne change rien.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import {
  saveToken,
  deleteStoredToken,
  validateToken,
  updateValidationCache,
} from "@/lib/github-token";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { token?: string };
  const token = String(body.token || "").trim();
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  // Format check léger : ghp_*, github_pat_*, ghs_*, ghu_*
  if (!/^(ghp_|github_pat_|ghs_|ghu_)[A-Za-z0-9_]{20,}$/.test(token)) {
    return NextResponse.json({
      error: "invalid_token_format",
      hint: "Le token doit commencer par ghp_ (classic) ou github_pat_ (fine-grained).",
    }, { status: 400 });
  }

  // Validation live AVANT de sauver — refuse les tokens inutilisables.
  let login: string;
  let scopes: string[];
  try {
    const v = await validateToken(token);
    login = v.login;
    scopes = v.scopes;
  } catch (e) {
    return NextResponse.json({
      error: "validation_failed",
      details: String(e instanceof Error ? e.message : e),
    }, { status: 400 });
  }

  await saveToken(token, session.user.email);
  await updateValidationCache(login, scopes);

  await logAction("settings.update", `github_token_set:${login}`, {
    actor: session.user.email,
    ip: ipFromHeaders(req),
    scopes,
  });

  return NextResponse.json({ ok: true, login, scopes });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await deleteStoredToken();

  await logAction("settings.update", "github_token_deleted", {
    actor: session.user.email,
    ip: ipFromHeaders(req),
  });

  return NextResponse.json({ ok: true });
}
