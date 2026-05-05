/**
 * Approval Gate — défense contre les actions agent non sollicitées.
 *
 * Problème résolu : un prompt injection dans un email RAG, un PDF
 * uploadé, ou même un titre de page web peut convaincre le LLM d'appeler
 * un tool mutatif (install_workflow, install_agent_fr, restart_service…)
 * sans que l'utilisateur ait validé. La protection « le prompt système
 * dit à l'agent de demander confirmation » est INSUFFISANTE — un attaquant
 * peut faire dire au LLM « OK utilisateur a confirmé » sans aucune
 * interaction réelle.
 *
 * Solution : tout tool mutatif passe par `requireApproval()` qui :
 *   1. Au 1er appel (sans approval_token) → enregistre une demande
 *      « pending » sur disque (/data/concierge-approvals/<id>.json),
 *      retourne 202 + action_id au LLM.
 *   2. Le frontend poll `/api/concierge/pending` et affiche un banner
 *      avec [Approuver] / [Refuser].
 *   3. Le user clique → POST `/api/concierge/decide`. Si « approve »,
 *      le frontend ré-appelle le tool avec `approval_token=action_id`.
 *   4. `requireApproval()` reconnaît le token, vérifie qu'il match
 *      l'action+TTL, retourne les params APPROUVÉS (pas du body !),
 *      consume (delete) le pending.
 *
 * Sécurité :
 *   - Les params utilisés à l'exécution viennent du PENDING enregistré
 *     au 1er appel, pas du body de la 2nde requête → un attaquant ne
 *     peut pas changer `file: "evil.json"` après que l'admin ait
 *     approuvé `file: "innocent.json"`.
 *   - Token = 32 chars hex aléatoires (crypto.randomBytes).
 *   - TTL court (5 min) : si l'admin oublie d'approuver, l'action
 *     expire silencieusement.
 *   - L'enregistrement écrit le `caller_actor` (user qui a déclenché
 *     la conversation) pour audit.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NextResponse } from "next/server";

const APPROVALS_DIR =
  process.env.CONCIERGE_APPROVALS_DIR || "/data/concierge-approvals";

const TTL_MS = Number(process.env.CONCIERGE_APPROVAL_TTL_MS || 5 * 60 * 1000);

export interface PendingApproval {
  id: string;
  /** Slug du tool (ex: "install_workflow"). */
  action: string;
  /** Texte FR à afficher à l'utilisateur dans le banner. */
  description: string;
  /** Params qui seront utilisés à l'exécution si approuvé. */
  params: Record<string, unknown>;
  created_at: number;
  expires_at: number;
  status: "pending" | "approved" | "rejected";
  /** Identifie qui a déclenché (pour audit). */
  caller_actor?: string;
  /**
   * Sprint 1 P0 #2 — Identifiant utilisateur logique (NextAuth email).
   * Permet le scoping multi-user : `listActive()` filtre par userId.
   */
  user_id?: string;
  /**
   * Sprint 1 P0 #2 — Clé d'auto-approbation pour limiter la fatigue UI.
   * Forme typique : `<conversation_id>:<action>` ou `<exec_id>:<action>`.
   * Si l'utilisateur coche « ne plus me redemander pour cette tâche »,
   * la clé est mémorisée et toute future demande avec la même clé +
   * action est auto-approuvée (jusqu'à expiration TTL).
   */
  auto_approve_key?: string;
  /** True si l'utilisateur a coché « auto-approuver pour cette tâche » lors
   *  de la décision. */
  auto_approve_persistent?: boolean;
  /**
   * ID de conversation Dify pour grouper les approvals dans l'UI.
   */
  conversation_id?: string;
}

async function ensureDir() {
  await fs.mkdir(APPROVALS_DIR, { recursive: true });
}

function fileFor(id: string) {
  // ID est validé hex → safe pour path
  return path.join(APPROVALS_DIR, `${id}.json`);
}

async function read(id: string): Promise<PendingApproval | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf-8"));
  } catch {
    return null;
  }
}

async function write(a: PendingApproval): Promise<void> {
  await ensureDir();
  await fs.writeFile(fileFor(a.id), JSON.stringify(a, null, 2), "utf-8");
}

async function remove(id: string): Promise<void> {
  await fs.unlink(fileFor(id)).catch(() => {});
}

/** Crée une nouvelle demande d'approbation pending. */
export async function createPending(opts: {
  action: string;
  description: string;
  params: Record<string, unknown>;
  caller_actor?: string;
  user_id?: string;
  auto_approve_key?: string;
  conversation_id?: string;
}): Promise<PendingApproval> {
  const id = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const a: PendingApproval = {
    id,
    action: opts.action,
    description: opts.description,
    params: opts.params,
    created_at: now,
    expires_at: now + TTL_MS,
    status: "pending",
    caller_actor: opts.caller_actor,
    user_id: opts.user_id,
    auto_approve_key: opts.auto_approve_key,
    conversation_id: opts.conversation_id,
  };
  await write(a);
  return a;
}

/**
 * Cherche un précédent record approuvé avec auto_approve_persistent=true
 * pour la même clé+action, encore dans la fenêtre TTL. Si trouvé, retourne
 * ses params (utilisable comme "auto-approuver tacite") sans consommer le
 * record (il reste actif jusqu'à expiration).
 *
 * Renvoie `null` si pas de match.
 */
export async function findAutoApproved(
  action: string,
  auto_approve_key: string,
): Promise<PendingApproval | null> {
  if (!auto_approve_key) return null;
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(APPROVALS_DIR);
  } catch {
    return null;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.replace(/\.json$/, "");
    const a = await read(id);
    if (!a) continue;
    if (a.status !== "approved") continue;
    if (!a.auto_approve_persistent) continue;
    if (a.action !== action) continue;
    if (a.auto_approve_key !== auto_approve_key) continue;
    if (now > a.expires_at) {
      await remove(id);
      continue;
    }
    return a;
  }
  return null;
}

/** Liste les approvals encore actives (pending OU récemment décidées
 *  pour que le frontend voit le résultat avant cleanup). Auto-purge
 *  les expirées au passage.
 *
 *  Si `userId` est fourni → filtre les pending qui appartiennent à
 *  ce user (scoping multi-user). Les pending sans `user_id` sont
 *  considérées comme legacy/Concierge et restent visibles à tous
 *  (rétrocompat). */
export async function listActive(userId?: string): Promise<PendingApproval[]> {
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(APPROVALS_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const out: PendingApproval[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.replace(/\.json$/, "");
    const a = await read(id);
    if (!a) continue;
    if (a.status === "pending" && now > a.expires_at) {
      await remove(id);
      continue;
    }
    if (a.status !== "pending") continue;
    if (userId && a.user_id && a.user_id !== userId) continue;
    out.push(a);
  }
  return out.sort((x, y) => y.created_at - x.created_at);
}

/** L'utilisateur décide (approve ou reject).
 *
 *  Si `auto_approve_persistent` est `true` ET `decision === "approved"`
 *  ET la pending a un `auto_approve_key`, l'auto-approbation est
 *  mémorisée : toute future demande avec la même clé+action sera
 *  auto-approuvée par `findAutoApproved` jusqu'à expiration TTL. */
export async function decide(
  id: string,
  decision: "approved" | "rejected",
  opts?: { auto_approve_persistent?: boolean },
): Promise<PendingApproval | null> {
  const a = await read(id);
  if (!a) return null;
  if (Date.now() > a.expires_at) {
    await remove(id);
    return null;
  }
  if (a.status !== "pending") return a; // déjà décidé
  a.status = decision;
  if (decision === "approved" && opts?.auto_approve_persistent && a.auto_approve_key) {
    a.auto_approve_persistent = true;
  }
  await write(a);
  return a;
}

/** Appelé par le tool wrapper. Si approuvé+match → consume + retourne
 *  les params. Sinon → erreur. */
export async function consumeApproved(
  id: string,
  expectedAction: string,
): Promise<
  | { ok: true; params: Record<string, unknown>; caller_actor?: string }
  | { ok: false; reason: string }
> {
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return { ok: false, reason: "invalid_token_format" };
  }
  const a = await read(id);
  if (!a) return { ok: false, reason: "not_found_or_expired" };
  if (a.action !== expectedAction) return { ok: false, reason: "action_mismatch" };
  if (Date.now() > a.expires_at) {
    await remove(id);
    return { ok: false, reason: "expired" };
  }
  if (a.status === "rejected") {
    await remove(id);
    return { ok: false, reason: "rejected_by_user" };
  }
  if (a.status !== "approved") {
    return { ok: false, reason: `still_${a.status}` };
  }
  // Consume
  await remove(id);
  return { ok: true, params: a.params, caller_actor: a.caller_actor };
}

/**
 * Wrapper haut-niveau pour les handlers de tools mutatifs.
 *
 * Usage :
 *   const gate = await requireApproval({
 *     body, action: "install_workflow",
 *     description: `Installer le workflow « ${file} » dans n8n`,
 *     params: { file },
 *   });
 *   if (!gate.go) return gate.response;
 *   const { file } = gate.params as { file: string };
 *   // ... exécute l'action
 */
export async function requireApproval<T extends Record<string, unknown>>(opts: {
  body: T & { approval_token?: unknown };
  action: string;
  description: string;
  params: T;
  caller_actor?: string;
  /** Sprint 1 P0 #2 — owner Authentik (NextAuth email). */
  user_id?: string;
  /** Sprint 1 P0 #2 — clé d'auto-approbation. Si une approbation
   *  persistante existe pour cette (action, key) → auto-approuve. */
  auto_approve_key?: string;
  /** Sprint 1 P0 #2 — pour grouper dans l'UI. */
  conversation_id?: string;
}): Promise<
  | { go: true; params: T; via: "approval" | "auto_approve" }
  | { go: false; response: Response }
> {
  const token =
    typeof opts.body.approval_token === "string" ? opts.body.approval_token : "";

  // Cas 1 — token explicite : on consume l'approbation existante
  if (token) {
    const check = await consumeApproved(token, opts.action);
    if (!check.ok) {
      return {
        go: false,
        response: NextResponse.json(
          { ok: false, error: "approval_invalid", reason: check.reason },
          { status: 403 },
        ),
      };
    }
    return { go: true, params: check.params as T, via: "approval" };
  }

  // Cas 2 — pas de token mais une auto-approbation persistante existe
  // pour cette (action, auto_approve_key) → on bypasse silencieusement
  // (l'utilisateur a coché "ne plus me redemander pour cette tâche").
  if (opts.auto_approve_key) {
    const auto = await findAutoApproved(opts.action, opts.auto_approve_key);
    if (auto) {
      // Important : on ne consume PAS l'auto-approval (il reste actif
      // jusqu'à TTL pour les futurs appels avec la même clé). On
      // utilise les params COURANTS plutôt que ceux mémorisés, parce
      // qu'on est dans un mode "feu vert pour toute la tâche" — les
      // params varient à chaque step.
      return { go: true, params: opts.params, via: "auto_approve" };
    }
  }

  // Cas 3 — pas de token, pas d'auto-approval : créer un pending
  const pending = await createPending({
    action: opts.action,
    description: opts.description,
    params: opts.params,
    caller_actor: opts.caller_actor,
    user_id: opts.user_id,
    auto_approve_key: opts.auto_approve_key,
    conversation_id: opts.conversation_id,
  });
  return {
    go: false,
    response: NextResponse.json(
      {
        ok: false,
        requires_approval: true,
        action_id: pending.id,
        description: pending.description,
        auto_approve_offer: Boolean(opts.auto_approve_key),
        message:
          "Cette action attend l'approbation de l'utilisateur. Une bannière " +
          "« action en attente » s'affiche en haut de l'application BoxIA. " +
          "Une fois cliqué sur « Approuver », l'action s'exécutera. " +
          "Indique-le clairement à l'utilisateur dans ta réponse.",
      },
      { status: 202 },
    ),
  };
}
