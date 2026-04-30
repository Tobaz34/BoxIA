/**
 * Client Authentik (admin API) côté serveur.
 *
 * Utilisé uniquement par les routes /api/users/* — la clé n'est JAMAIS
 * exposée au client. La clé est provisionnée par sso_provisioning.py
 * (setup_authentik_management) → AUTHENTIK_API_TOKEN dans .env.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { isUserActive } from "@/lib/user-cache";

const AUTHENTIK_BASE_URL =
  process.env.AUTHENTIK_API_URL || "http://localhost:9000";
const AUTHENTIK_API_TOKEN = process.env.AUTHENTIK_API_TOKEN || "";

export const ADMIN_GROUP_NAME = "authentik Admins";
export const MANAGER_GROUP_NAME = "AI Box — Managers";
export const EMPLOYEE_GROUP_NAME = "AI Box — Employés";

export type AiBoxRole = "admin" | "manager" | "employee";

/** Convertit un tableau de noms de groupes en rôle AI Box.
 *  Priorité : admin > manager > employee. */
export function rolesToAiBox(groupNames: string[]): AiBoxRole {
  if (groupNames.includes(ADMIN_GROUP_NAME)) return "admin";
  if (groupNames.includes(MANAGER_GROUP_NAME)) return "manager";
  return "employee";
}

/** Vérifie que l'appelant est admin ; sinon renvoie une 403. */
export async function requireAdmin(): Promise<
  | { user: { email: string; name?: string | null; isAdmin: boolean; groups: string[] } }
  | NextResponse
> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const u = session.user as {
    email: string;
    name?: string | null;
    isAdmin?: boolean;
    groups?: string[];
  };
  if (!u.isAdmin) {
    return NextResponse.json(
      { error: "forbidden", message: "Réservé aux administrateurs." },
      { status: 403 },
    );
  }
  // Auto-déconnexion live : si le user a été désactivé côté Authentik
  // depuis l'émission de son JWT, on le bloque sans attendre la fin
  // de session (TTL cache 3 min).
  const active = await isUserActive(u.email);
  if (!active.active) {
    return NextResponse.json(
      { error: "user_disabled",
        message: "Votre compte a été désactivé." },
      { status: 403 },
    );
  }
  if (!AUTHENTIK_API_TOKEN) {
    return NextResponse.json(
      {
        error: "ak_unavailable",
        message:
          "Le service de gestion Authentik n'est pas configuré. " +
          "Demandez à l'administrateur de relancer le provisioning.",
      },
      { status: 503 },
    );
  }
  return {
    user: {
      email: u.email,
      name: u.name,
      isAdmin: !!u.isAdmin,
      groups: u.groups || [],
    },
  };
}

/** Wrapper minimaliste pour appeler l'API Authentik avec le bearer token. */
export async function akFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${AUTHENTIK_API_TOKEN}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${AUTHENTIK_BASE_URL}/api/v3${path}`, { ...init, headers });
}

export interface AkUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser?: boolean;
  last_login?: string | null;
  date_joined?: string;
  groups?: string[];                  // PKs (UUID)
  groups_obj?: { pk: string; name: string }[]; // si expanded
  attributes?: Record<string, unknown>;
}

export interface AkGroup {
  pk: string;
  name: string;
  is_superuser: boolean;
  num_pk?: number;
}

/** Public-shape (envoyée au client). */
export interface PublicUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  role: AiBoxRole;
  last_login: string | null;
  date_joined: string | null;
}

/** Convertit une AkUser (réponse Authentik) en PublicUser. */
export function toPublicUser(u: AkUser): PublicUser {
  const groupNames = (u.groups_obj || []).map((g) => g.name);
  // Authentik flag is_superuser fait aussi office d'admin
  const role = u.is_superuser ? "admin" : rolesToAiBox(groupNames);
  return {
    pk: u.pk,
    username: u.username,
    name: u.name || u.username,
    email: u.email,
    is_active: u.is_active,
    role,
    last_login: u.last_login || null,
    date_joined: u.date_joined || null,
  };
}
