/**
 * Endpoint de gestion du flag « mot de passe par défaut » de l'utilisateur
 * connecté.
 *
 * GET    /api/me/password-status → { must_change: bool, change_url: string }
 *   - Lit l'attribut `must_change_password` côté Authentik.
 *   - Si vrai, l'app affiche une bannière persistante (cf. PasswordChangeBanner).
 *   - `change_url` : URL de la page de changement de mot de passe Authentik
 *     (interface user, non admin).
 *
 * POST   /api/me/password-status { dismissed: true }
 *   - Appelé après que l'utilisateur a changé son mot de passe dans Authentik.
 *   - Met `attributes.must_change_password=False` côté Authentik. Idempotent.
 *   - Pas de validation que le pwd a vraiment été changé (l'Authentik admin
 *     API ne le permet pas sans pré-stocker un état). UX-tradeoff acceptable
 *     pour une box LAN.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { akFetch, type AkUser } from "@/lib/authentik";

export const dynamic = "force-dynamic";

const AUTHENTIK_BROWSER_URL =
  // URL côté navigateur (HTTPS via Caddy edge, ou IP:port en fallback).
  // Issuer NextAuth contient déjà l'URL public-facing → on la dérive.
  // Note: docker-compose mappe AUTHENTIK_APP_ISSUER (.env) → AUTHENTIK_ISSUER
  // (env aibox-app). On lit les deux pour être robuste, et on garde
  // AUTHENTIK_API_URL en dernier ressort (mais c'est en interne donc pas
  // utilisable côté navigateur — mieux vaut "" que localhost:9000).
  (process.env.AUTHENTIK_ISSUER
    || process.env.AUTHENTIK_APP_ISSUER
    || "")
    .replace(/\/application\/o\/[^/]+\/?$/, "")  // strip /application/o/<slug>/
    .replace(/\/$/, "");

async function findUserByEmail(email: string): Promise<AkUser | null> {
  const r = await akFetch(`/core/users/?email=${encodeURIComponent(email)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j.results && j.results[0]) || null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await findUserByEmail(session.user.email);
  if (!user) {
    return NextResponse.json({
      must_change: false,
      reason: "user_not_found",
    });
  }
  let mustChange = Boolean(
    user.attributes && (user.attributes as Record<string, unknown>).must_change_password,
  );

  // Self-healing : si Authentik trace `password_change_date > date_joined`,
  // c'est que l'admin a réellement changé son pwd à un moment donné
  // (depuis le wizard) — on peut clear le flag sans demander de confirmation.
  // Évite que la bannière reste affichée à vie pour les users qui ont changé
  // leur mdp mais oublié de cliquer « J'ai changé ».
  if (mustChange) {
    const u = user as unknown as Record<string, unknown>;
    const changeDate = typeof u.password_change_date === "string"
      ? Date.parse(u.password_change_date) : NaN;
    const joinedDate = typeof u.date_joined === "string"
      ? Date.parse(u.date_joined) : NaN;
    // +5s de tolérance car Authentik écrit password_change_date à la création
    // de l'user (souvent égal à date_joined à la milliseconde près).
    if (
      Number.isFinite(changeDate) && Number.isFinite(joinedDate) &&
      changeDate - joinedDate > 5_000
    ) {
      // Best-effort PATCH pour persister — si ça foire, pas grave, le check
      // sera refait au prochain GET.
      try {
        const newAttrs = {
          ...(user.attributes || {}),
          must_change_password: false,
        };
        await akFetch(`/core/users/${user.pk}/`, {
          method: "PATCH",
          body: JSON.stringify({ attributes: newAttrs }),
        });
      } catch {
        // silencieux
      }
      mustChange = false;
    }
  }

  return NextResponse.json({
    must_change: mustChange,
    // URL utilisateur Authentik : page « Mes paramètres » avec l'onglet
    // mot de passe. Format Authentik 2024+ : /if/user/#/settings;page-id=page-mfa
    change_url: AUTHENTIK_BROWSER_URL
      ? `${AUTHENTIK_BROWSER_URL}/if/user/#/settings`
      : "",
    username: user.username,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (body.dismissed !== true) {
    return NextResponse.json(
      { error: "bad_request", message: "Body doit contenir { dismissed: true }" },
      { status: 400 },
    );
  }
  const user = await findUserByEmail(session.user.email);
  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  // PATCH les attributes pour clear le flag. On garde les autres
  // attributes intactes (groups, etc. sont gérés ailleurs, attributes
  // est un JSONField libre).
  const newAttrs = { ...(user.attributes || {}), must_change_password: false };
  const r = await akFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ attributes: newAttrs }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_patch_failed", status: r.status,
        body: text.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, must_change: false });
}
