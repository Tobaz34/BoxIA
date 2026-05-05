/**
 * POST /api/agents-tools/bash_exec
 *
 * Tool agents-tools qui permet au Concierge d'exécuter du code bash ou
 * python dans la sandbox isolée (services/sandbox).
 *
 * SÉCURITÉ — multi-couches :
 *  1. Approval gate (lib/approval-gate.ts) — l'admin DOIT cliquer
 *     "Approuver" dans le banner avant l'exec. is_sensitive_action: true
 *     dans TOOL_META (cf D7). Banner RED + auditor 2-pass si
 *     audit_context propagé (X-Audit-Context header).
 *  2. Le sandbox lui-même tourne sous gVisor (runtime: runsc) avec
 *     filesystem read-only sauf /tmp/work, network=none par défaut,
 *     mémoire 512 MB, CPU 1 core, timeout 30s default.
 *  3. Les params bash/python passent par le pending → params APPROUVÉS
 *     (le Concierge ne peut pas modifier le code entre approve et exec).
 *
 * Body : {
 *   lang: "bash" | "python",
 *   code: string (max 128 KB),
 *   timeout_seconds?: number (1..300),
 *   session_id?: string ([a-zA-Z0-9_-]{1,40}, persistant entre runs),
 *   env?: { VAR: VAL } (max 10, refuse les noms secrets),
 *   approval_token?: string (consumé après approve UI)
 * }
 *
 * Auth : Bearer AGENTS_API_KEY.
 *
 * Référence : tools/research/audit_P0_01_sandbox.md.
 *
 * IMPORTANT : ce tool ne marchera PAS tant que :
 * 1. Le service `services/sandbox/` n'est pas déployé (compose up)
 * 2. La var env SANDBOX_URL n'est pas configurée (défaut http://aibox-sandbox:8000)
 * 3. POC gVisor S0.4 validé sur xefia
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { logAction } from "@/lib/audit-helper";
import { requireApproval } from "@/lib/approval-gate";
import {
  toolError,
  toolValidationError,
  toolUpstreamError,
} from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

const SANDBOX_URL = process.env.SANDBOX_URL || "http://aibox-sandbox:8000";
const AGENTS_API_KEY = process.env.AGENTS_API_KEY || "";
const SANDBOX_DEFAULT_TIMEOUT = Number(
  process.env.SANDBOX_DEFAULT_TIMEOUT || 30,
);
const SANDBOX_MAX_TIMEOUT = Number(process.env.SANDBOX_MAX_TIMEOUT || 300);

interface PostBody {
  lang?: unknown;
  code?: unknown;
  timeout_seconds?: unknown;
  session_id?: unknown;
  env?: unknown;
  approval_token?: unknown;
}

interface SandboxFile {
  name: string;
  size: number;
}

interface SandboxResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files_created: SandboxFile[];
  runtime_info: Record<string, unknown>;
  error?: string;
}

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "bash_exec", req });

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    tracer.failure({ errorCode: "bad_json", retryable: false, httpStatus: 400 });
    return toolValidationError("bad_json", "Body JSON invalide");
  }

  const lang = typeof body.lang === "string" ? body.lang : "";
  const code = typeof body.code === "string" ? body.code : "";

  if (lang !== "bash" && lang !== "python") {
    tracer.failure({ errorCode: "invalid_lang", retryable: false, httpStatus: 400 });
    return toolValidationError(
      "invalid_lang",
      "Champ 'lang' doit être 'bash' ou 'python'.",
    );
  }
  if (!code || code.length < 1) {
    tracer.failure({ errorCode: "missing_code", retryable: false, httpStatus: 400 });
    return toolValidationError("missing_code", "Champ 'code' requis.");
  }
  if (code.length > 128 * 1024) {
    tracer.failure({ errorCode: "code_too_large", retryable: false, httpStatus: 400 });
    return toolValidationError(
      "code_too_large",
      "Champ 'code' max 128 KB.",
    );
  }

  const requestedTimeout = Number(body.timeout_seconds);
  const timeoutSeconds =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(SANDBOX_MAX_TIMEOUT, Math.max(1, Math.floor(requestedTimeout)))
      : SANDBOX_DEFAULT_TIMEOUT;

  // Approval gate avec propagation user_id / conversation_id /
  // audit_context (P0 #2 + #3) — bash_exec est sensitive=true par TOOL_META.
  const userIdHeader = req.headers.get("x-user-id") || undefined;
  const conversationHeader = req.headers.get("x-conversation-id") || undefined;
  const auditContextHeader = req.headers.get("x-audit-context") || undefined;
  const autoApproveKey = conversationHeader
    ? `${conversationHeader}:bash_exec`
    : undefined;

  // Description courte AVEC le langage et un excerpt du code (truncé) pour
  // que l'admin voit ce qu'il approuve dans le banner. Pas tout le code
  // sinon le banner devient illisible — l'admin peut cliquer "voir détail"
  // pour voir le code complet (params dans le pending).
  const codeExcerpt = code.replace(/\s+/g, " ").slice(0, 200);
  const description =
    `Exécuter du code ${lang.toUpperCase()} dans la sandbox isolée ` +
    `(timeout ${timeoutSeconds}s) :\n\n${codeExcerpt}` +
    (code.length > 200 ? "…" : "");

  const gate = await requireApproval<{
    lang: string;
    code: string;
    timeout_seconds: number;
    session_id?: string;
    env?: Record<string, string>;
  }>({
    body: body as { approval_token?: unknown } & {
      lang: string;
      code: string;
      timeout_seconds: number;
    },
    action: "bash_exec",
    description,
    params: {
      lang,
      code,
      timeout_seconds: timeoutSeconds,
      session_id: typeof body.session_id === "string" ? body.session_id : undefined,
      env: typeof body.env === "object" && body.env !== null
        ? (body.env as Record<string, string>)
        : undefined,
    },
    caller_actor: "concierge-agent",
    user_id: userIdHeader,
    conversation_id: conversationHeader,
    auto_approve_key: autoApproveKey,
    audit_context: auditContextHeader,
  });
  if (!gate.go) {
    tracer.failure({
      errorCode: "approval_pending_or_denied",
      retryable: false,
      metadata: { stage: "approval_gate", lang },
    });
    return gate.response;
  }

  // Params APPROUVÉS — pas du body, du pending stocké
  const approved = gate.params;

  // Appel sandbox
  if (!AGENTS_API_KEY) {
    tracer.failure({
      errorCode: "missing_agents_api_key",
      retryable: false,
      httpStatus: 500,
    });
    return toolError({
      error: "missing_agents_api_key",
      hint: "AGENTS_API_KEY non configuré côté serveur.",
      status: 500,
      retryable: false,
    });
  }

  let sandboxResp: SandboxResponse;
  try {
    const r = await fetch(`${SANDBOX_URL}/v1/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENTS_API_KEY}`,
      },
      body: JSON.stringify(approved),
      signal: AbortSignal.timeout((approved.timeout_seconds + 30) * 1000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      tracer.failure({
        errorCode: "sandbox_upstream_error",
        retryable: r.status >= 500,
        httpStatus: 502,
        metadata: { upstream_status: r.status },
      });
      return toolUpstreamError({
        error: "sandbox_upstream_error",
        hint:
          "Le sandbox n'a pas pu exécuter le code (service non-déployé ? gVisor refuse ?).",
        upstreamStatus: r.status,
        detail: text.slice(0, 200),
      });
    }
    sandboxResp = (await r.json()) as SandboxResponse;
  } catch (e: unknown) {
    tracer.failure({
      errorCode: "sandbox_network_error",
      retryable: true,
      httpStatus: 502,
      metadata: { reason: String(e).slice(0, 100) },
    });
    return toolUpstreamError({
      error: "sandbox_network_error",
      hint: "Sandbox injoignable (network ou timeout).",
      detail: String(e).slice(0, 200),
    });
  }

  // Audit log + tracer
  await logAction(
    "agent.chat",
    "concierge-agent",
    {
      tool: "bash_exec",
      lang: approved.lang,
      timeout_s: approved.timeout_seconds,
      ok: sandboxResp.ok,
      exit_code: sandboxResp.exit_code,
      timed_out: sandboxResp.timed_out,
      duration_ms: sandboxResp.duration_ms,
      files_count: sandboxResp.files_created.length,
      stdout_truncated: sandboxResp.stdout_truncated,
      session_id: approved.session_id,
    },
    null,
  );
  tracer.success(
    {
      ok: sandboxResp.ok,
      exit_code: sandboxResp.exit_code,
      files_count: sandboxResp.files_created.length,
    },
    {
      lang: approved.lang,
      timeout_s: approved.timeout_seconds,
      duration_ms: sandboxResp.duration_ms,
      timed_out: sandboxResp.timed_out,
    },
  );

  // Hint pour le LLM appelant — guide l'usage du résultat
  const hint = sandboxResp.timed_out
    ? `Le code a dépassé le timeout (${approved.timeout_seconds}s). Optimise-le ou augmente timeout_seconds (max ${SANDBOX_MAX_TIMEOUT}s).`
    : !sandboxResp.ok
      ? `Le code a échoué (exit code ${sandboxResp.exit_code}). Lis stderr pour comprendre, corrige et re-essaie.`
      : sandboxResp.files_created.length > 0
        ? `Code OK. ${sandboxResp.files_created.length} fichier(s) généré(s) dans /tmp/work. Mentionne-les à l'user dans ta réponse — ils seront supprimés en fin de session.`
        : `Code OK. Cite stdout dans ta réponse à l'user.`;

  return NextResponse.json({
    ok: sandboxResp.ok,
    stdout: sandboxResp.stdout,
    stderr: sandboxResp.stderr,
    exit_code: sandboxResp.exit_code,
    duration_ms: sandboxResp.duration_ms,
    timed_out: sandboxResp.timed_out,
    stdout_truncated: sandboxResp.stdout_truncated,
    stderr_truncated: sandboxResp.stderr_truncated,
    files_created: sandboxResp.files_created,
    hint,
  });
}
