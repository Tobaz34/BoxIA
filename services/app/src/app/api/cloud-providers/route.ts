/**
 * GET /api/cloud-providers — liste des providers cloud configurables
 *                            + état actuel + budget + PII scrub on/off.
 * POST /api/cloud-providers — { id, api_key, enabled_models[] } : configure
 *                             un provider (push la clé à Dify + persiste l'état).
 * DELETE /api/cloud-providers?id=<provider_id> — révoque un provider.
 *
 * Admin only (configuration sensible).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  CLOUD_PROVIDERS,
  readCloudProvidersState,
  setProviderConfigured,
  setProviderApiKeyLocal,
  removeProviderConfig,
  setBudget,
  setPiiScrub,
  type CloudProviderId,
} from "@/lib/cloud-providers";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const VALID_IDS = new Set<string>(CLOUD_PROVIDERS.map((p) => p.id));

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = await readCloudProvidersState();
  return NextResponse.json({
    catalog: CLOUD_PROVIDERS,
    state: state.providers,
    budget_monthly_eur: state.budget_monthly_eur,
    pii_scrub_enabled: state.pii_scrub_enabled,
  });
}

interface PostBody {
  id?: string;
  api_key?: string;
  enabled_models?: string[];
  // Settings globaux (mode "update settings only")
  budget_monthly_eur?: number;
  pii_scrub_enabled?: boolean;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Mode "settings only" (pas de provider id) → maj budget / pii scrub
  if (!body.id && (body.budget_monthly_eur !== undefined || body.pii_scrub_enabled !== undefined)) {
    if (typeof body.budget_monthly_eur === "number") {
      await setBudget(body.budget_monthly_eur);
    }
    if (typeof body.pii_scrub_enabled === "boolean") {
      await setPiiScrub(body.pii_scrub_enabled);
    }
    await logAction("settings.update", session.user.email, {
      target: "cloud-providers",
      budget: body.budget_monthly_eur,
      pii_scrub: body.pii_scrub_enabled,
    }, ipFromHeaders(req));
    return NextResponse.json({ ok: true, settings_updated: true });
  }

  // Mode "configure provider"
  if (!body.id || !VALID_IDS.has(body.id)) {
    return NextResponse.json(
      { error: "missing_or_invalid_id", valid: Array.from(VALID_IDS) },
      { status: 400 },
    );
  }
  if (!body.api_key || typeof body.api_key !== "string" || body.api_key.length < 20) {
    return NextResponse.json(
      { error: "missing_api_key", hint: "Saisis ta clé API du provider (≥ 20 caractères)" },
      { status: 400 },
    );
  }

  const id = body.id as CloudProviderId;
  const provider = CLOUD_PROVIDERS.find((p) => p.id === id)!;
  const enabled_models =
    Array.isArray(body.enabled_models) && body.enabled_models.length > 0
      ? body.enabled_models
      : provider.default_models;

  // Stratégie dual-store :
  //   1. Pousse la clé à Dify (chiffrement at-rest côté Dify) — utile si
  //      le plugin <provider> est installé (Dify peut alors invoker le
  //      modèle via son orchestration).
  //   2. Stocke aussi la clé chiffrée localement (AES-256-GCM via
  //      NEXTAUTH_SECRET) pour permettre les appels directs du provider
  //      via /api/chat-cloud quand Dify n'a pas le plugin (cas BoxIA
  //      self-hosted sans accès marketplace.dify.ai).
  //
  // Si Dify rejette (plugin absent), on continue quand même (warning)
  // pour que le bouton "Utiliser cette fois" de la modale fonctionne.
  let difyOk = false;
  let difyError: string | null = null;
  try {
    const { configureCloudProviderInDify } = await import("@/lib/dify-cloud-providers");
    const r = await configureCloudProviderInDify(id, body.api_key, enabled_models);
    difyOk = r.ok;
    if (!r.ok) difyError = r.error;
  } catch (e) {
    difyError = String(e).slice(0, 300);
  }

  // Stocke localement (chiffré). Toujours fait, indépendamment de Dify.
  await setProviderApiKeyLocal(id, body.api_key);

  // Met à jour l'état (préfixe pour ID UI + flag configured = true)
  const key_prefix = body.api_key.slice(0, 8) + "…";
  const state = await setProviderConfigured(id, key_prefix, enabled_models);

  await logAction("settings.update", session.user.email, {
    target: "cloud-providers",
    action: "configure",
    provider: id,
    models: enabled_models,
    key_prefix,
    dify_ok: difyOk,
    dify_error: difyError,
  }, ipFromHeaders(req));

  return NextResponse.json({
    ok: true,
    state,
    dify_ok: difyOk,
    dify_error: difyError,
    local_store: true,
    note: !difyOk
      ? "Plugin Dify indisponible. La clé est stockée localement et utilisable via le bouton 'Utiliser cette fois' de la modale fallback cloud."
      : undefined,
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id || !VALID_IDS.has(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  await removeProviderConfig(id as CloudProviderId);
  await logAction("settings.update", session.user.email, {
    target: "cloud-providers",
    action: "revoke",
    provider: id,
  }, ipFromHeaders(req));
  return NextResponse.json({ ok: true, revoked: id });
}
