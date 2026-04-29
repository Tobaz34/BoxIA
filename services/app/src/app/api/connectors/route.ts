/**
 * GET /api/connectors — liste l'état des connecteurs IA (containers aibox-conn-*).
 *
 * Renvoie pour chaque connecteur configuré dans le catalog :
 *   { id, name, icon, brand, running, last_sync? }
 *
 * Source : interroge Docker socket via /var/run/docker.sock (monté dans le container).
 */
import { NextResponse } from "next/server";
import * as net from "net";

interface ConnectorInfo {
  id: string;
  name: string;
  brand: string;            // "Microsoft" | "Google" | "Odoo" | ...
  icon: string;
  container_name: string;
  running: boolean;
  configured: boolean;
}

// Catalogue des connecteurs côté UI
const CATALOG: Omit<ConnectorInfo, "running" | "configured">[] = [
  { id: "rag-msgraph",       name: "SharePoint / OneDrive", brand: "Microsoft", icon: "🪟", container_name: "aibox-conn-rag-msgraph" },
  { id: "email-msgraph",     name: "Outlook / Exchange",    brand: "Microsoft", icon: "📧", container_name: "aibox-conn-email-msgraph" },
  { id: "rag-gdrive",        name: "Google Drive",           brand: "Google",   icon: "🟢", container_name: "aibox-conn-rag-gdrive" },
  { id: "email-gmail",       name: "Gmail",                  brand: "Google",   icon: "📧", container_name: "aibox-conn-email-gmail" },
  { id: "email-imap",        name: "Email IMAP",             brand: "IMAP",     icon: "✉️", container_name: "aibox-conn-email-imap" },
  { id: "rag-smb",           name: "NAS / SMB",              brand: "NAS",      icon: "🗄️", container_name: "aibox-conn-rag-smb" },
  { id: "rag-nextcloud",     name: "Nextcloud",              brand: "Nextcloud",icon: "☁️", container_name: "aibox-conn-rag-nextcloud" },
  { id: "erp-odoo",          name: "Odoo",                   brand: "Odoo",     icon: "🟣", container_name: "aibox-conn-erp-odoo" },
  { id: "text2sql",          name: "Base SQL",               brand: "Database", icon: "🗃️", container_name: "aibox-conn-text2sql" },
  { id: "helpdesk-glpi",     name: "GLPI Helpdesk",          brand: "GLPI",     icon: "🎫", container_name: "aibox-conn-helpdesk-glpi" },
];

/** Appel direct au socket Docker via HTTP (Unix domain socket). */
function dockerRequest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection("/var/run/docker.sock");
    let buffer = "";
    client.on("connect", () => {
      client.write(`GET ${path} HTTP/1.0\r\nHost: localhost\r\n\r\n`);
    });
    client.on("data", (d) => (buffer += d.toString()));
    client.on("end", () => resolve(buffer));
    client.on("error", reject);
    setTimeout(() => { client.destroy(); reject(new Error("timeout")); }, 3000);
  });
}

async function listRunningContainers(): Promise<Set<string>> {
  try {
    const raw = await dockerRequest("/containers/json?all=false");
    const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    const containers = JSON.parse(body) as Array<{ Names: string[] }>;
    const names = new Set<string>();
    for (const c of containers) {
      for (const n of c.Names) names.add(n.replace(/^\//, ""));
    }
    return names;
  } catch {
    return new Set();
  }
}

export async function GET() {
  const running = await listRunningContainers();

  const result: ConnectorInfo[] = CATALOG.map((c) => ({
    ...c,
    running: running.has(c.container_name),
    configured: running.has(c.container_name),  // simplification : si container up = configuré
  }));

  // Group par brand pour l'affichage
  const grouped: Record<string, ConnectorInfo[]> = {};
  for (const c of result) {
    if (!grouped[c.brand]) grouped[c.brand] = [];
    grouped[c.brand].push(c);
  }

  return NextResponse.json({
    connectors: result,
    grouped,
    summary: {
      total: result.length,
      running: result.filter((c) => c.running).length,
    },
  });
}
