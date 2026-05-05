/**
 * GET /api/connectors/[slug]/status
 *
 * Vue agrégée pour la modale "Statut" du connecteur. Combine :
 *   - Compte OAuth connecté (email + name + scopes humanisés)
 *   - Périmètre (folders / drives / inbox / calendar) selon le type :
 *       · google-drive            → "Drive de l'utilisateur" (et shared_drive_id si défini)
 *       · onedrive                → "OneDrive de l'utilisateur"
 *       · sharepoint              → liste des bibliothèques cochées (sharepoint-config.json)
 *       · gmail / outlook-graph   → adresse de l'inbox + count messages (via Graph/Gmail)
 *       · google-calendar / outlook-calendar → calendrier + count events sur 30 jours
 *   - Indexation RAG (si applicable) : Qdrant collection name + points + status + last sync
 *   - Container worker : running, started_at, log line
 *
 * Best-effort : un sous-call qui échoue n'invalide pas tout — on renvoie
 * `null` ou un message d'erreur scope-spécifique.
 *
 * Admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { _readStore } from "@/lib/oauth-storage";
import { getConnector } from "@/lib/connectors";
import { getCollection } from "@/lib/qdrant-client";
import { getToolToken } from "@/lib/connector-tool-helpers";
import { listStates } from "@/lib/connectors-state";
import { humanizeScopes } from "@/lib/oauth-providers";
import { promises as fs } from "node:fs";
import http from "node:http";

export const dynamic = "force-dynamic";

const DOCKER_SOCK = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

interface ContainerInfo {
  found: boolean;
  running: boolean;
  startedAt?: string;
}

function dockerInspect(name: string): Promise<ContainerInfo> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: `/containers/${name}/json`,
        method: "GET",
        headers: { Host: "docker", Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode === 404) return resolve({ found: false, running: false });
          try {
            const j = JSON.parse(data);
            resolve({
              found: true,
              running: !!j.State?.Running,
              startedAt: j.State?.StartedAt,
            });
          } catch {
            resolve({ found: false, running: false });
          }
        });
      },
    );
    req.on("error", () => resolve({ found: false, running: false }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ found: false, running: false }); });
    req.end();
  });
}

const RAG_SLUGS: Record<string, { container: string; collection_prefix: string }> = {
  "google-drive": { container: "aibox-conn-rag-gdrive", collection_prefix: "rag_gdrive_" },
  "onedrive": { container: "aibox-conn-rag-msgraph", collection_prefix: "rag_msgraph_" },
  "sharepoint": { container: "aibox-conn-rag-msgraph", collection_prefix: "rag_msgraph_" },
};

async function gmailCount(token: string): Promise<number | null> {
  try {
    const r = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.messagesTotal === "number" ? j.messagesTotal : null;
  } catch {
    return null;
  }
}

async function outlookMailCount(token: string): Promise<number | null> {
  try {
    const r = await fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount",
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.totalItemCount === "number" ? j.totalItemCount : null;
  } catch {
    return null;
  }
}

async function calendarUpcomingCount(
  token: string,
  provider: "google" | "microsoft",
): Promise<number | null> {
  try {
    const now = new Date().toISOString();
    const in30d = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    if (provider === "google") {
      const r = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(in30d)}&singleEvents=true&maxResults=2500`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) },
      );
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.items) ? j.items.length : null;
    } else {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(now)}&endDateTime=${encodeURIComponent(in30d)}&$top=999&$count=true`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ConsistencyLevel: "eventual",
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!r.ok) return null;
      const j = await r.json();
      if (typeof j["@odata.count"] === "number") return j["@odata.count"];
      return Array.isArray(j.value) ? j.value.length : null;
    }
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await params;
  const spec = getConnector(slug);
  if (!spec) {
    return NextResponse.json({ error: "unknown_connector" }, { status: 404 });
  }

  // 1. Compte OAuth
  const store = await _readStore();
  const conn = Object.values(store.connections).find(
    (c) => c.connector_slug === slug,
  );
  const account = conn ? {
    email: conn.account_email || null,
    name: conn.account_name || null,
    provider_id: conn.provider_id,
    scopes_human: humanizeScopes(conn.scopes || []),
    expires_at: conn.expires_at || null,
    connected_at: conn.connected_at,
  } : null;

  // 2. État du connector
  const states = await listStates();
  const connectorState = states[slug] || null;

  // 3. RAG (si applicable)
  let rag: {
    container: string;
    running: boolean;
    started_at?: string;
    collection: string;
    points: number;
    qdrant_status: string;
  } | null = null;
  const ragInfo = RAG_SLUGS[slug];
  if (ragInfo) {
    const tenant = (process.env.CLIENT_NAME || "default").toUpperCase();
    const collection = `${ragInfo.collection_prefix}${tenant}`;
    const [container, coll] = await Promise.all([
      dockerInspect(ragInfo.container),
      getCollection(collection).catch(() => null),
    ]);
    rag = {
      container: ragInfo.container,
      running: container.running,
      started_at: container.startedAt,
      collection,
      points: coll?.points_count ?? 0,
      qdrant_status: coll?.status ?? "unknown",
    };
  }

  // 4. Périmètre selon le type
  let scope: Record<string, unknown> = {};
  if (slug === "sharepoint") {
    try {
      const raw = await fs.readFile("/data/sharepoint-config.json", "utf-8");
      const cfg = JSON.parse(raw);
      scope = {
        type: "sharepoint_libraries",
        libraries: cfg.drive_ids || [],
      };
    } catch {
      scope = { type: "sharepoint_libraries", libraries: [] };
    }
  } else if (slug === "google-drive") {
    scope = {
      type: "google_drive",
      shared_drive_id: connectorState?.config?.shared_drive_id || null,
      mode: connectorState?.config?.shared_drive_id ? "shared_drive" : "user_drive",
    };
  } else if (slug === "onedrive") {
    scope = { type: "onedrive_user", mode: "user_drive" };
  } else if (slug === "gmail" && conn) {
    const tok = await getToolToken("google", "gmail");
    if (tok.ok) {
      const count = await gmailCount(tok.token);
      scope = {
        type: "gmail_inbox",
        messages_total: count,
        rag_indexed: false,
        note: "Indexation RAG des emails à venir. Pour l'instant les agents IA peuvent lire la boîte à la demande via les tools Dify (gmail_read_inbox, gmail_search, gmail_get_thread).",
      };
    } else {
      scope = { type: "gmail_inbox", error: "no_token" };
    }
  } else if (slug === "outlook-graph" && conn) {
    const tok = await getToolToken("microsoft", "outlook-graph");
    if (tok.ok) {
      const count = await outlookMailCount(tok.token);
      scope = {
        type: "outlook_inbox",
        messages_total: count,
        rag_indexed: false,
        note: "Indexation RAG des emails à venir. Pour l'instant les agents IA peuvent lire la boîte à la demande via les tools Dify (outlook_read_inbox, outlook_search, outlook_get_message).",
      };
    } else {
      scope = { type: "outlook_inbox", error: "no_token" };
    }
  } else if (slug === "google-calendar" && conn) {
    const tok = await getToolToken("google", "google-calendar");
    if (tok.ok) {
      const count = await calendarUpcomingCount(tok.token, "google");
      scope = {
        type: "google_calendar",
        upcoming_30d: count,
        rag_indexed: false,
        note: "Pas d'indexation RAG des événements (peu de valeur). Les agents IA accèdent au calendrier via les tools Dify (calendar_today, calendar_find_free_slot).",
      };
    } else {
      scope = { type: "google_calendar", error: "no_token" };
    }
  } else if (slug === "outlook-calendar" && conn) {
    const tok = await getToolToken("microsoft", "outlook-calendar");
    if (tok.ok) {
      const count = await calendarUpcomingCount(tok.token, "microsoft");
      scope = {
        type: "outlook_calendar",
        upcoming_30d: count,
        rag_indexed: false,
        note: "Pas d'indexation RAG des événements (peu de valeur). Les agents IA accèdent au calendrier via les tools Dify (calendar_today, calendar_find_free_slot).",
      };
    } else {
      scope = { type: "outlook_calendar", error: "no_token" };
    }
  } else {
    scope = { type: "unknown" };
  }

  return NextResponse.json({
    slug,
    spec_name: spec.name,
    spec_icon: spec.icon,
    connector_state: connectorState ? {
      status: connectorState.status,
      activated_at: connectorState.activated_at,
      last_sync_at: connectorState.last_sync_at,
      last_error: connectorState.last_error,
    } : null,
    account,
    rag,
    scope,
  });
}
