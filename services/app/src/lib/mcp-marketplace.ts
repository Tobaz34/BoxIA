/**
 * MCP marketplace — lecture du catalogue local de serveurs MCP.
 *
 * Catalogue dans `templates/mcp/_catalog.json` (bind-mounté en
 * `/templates/mcp/_catalog.json`). Liste des serveurs MCP officiels
 * Anthropic + serveurs communautaires curés.
 *
 * L'install RÉELLE d'un serveur MCP se fait côté Dify (Outils → MCP
 * Server) ou via un futur runtime side-car. Pour V1, on expose juste le
 * catalogue en lecture + un lien direct SSO vers Dify.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const TEMPLATES_DIR = process.env.MCP_TEMPLATES_DIR || "/templates/mcp";

export type McpCategory =
  | "official"
  | "dev"
  | "data"
  | "communication"
  | "productivity"
  | "search"
  | "monitoring";

export interface McpCategoryDef {
  id: McpCategory;
  label: string;
  icon: string;
}

export interface McpConfigField {
  key: string;
  label: string;
  type: "string" | "secret";
}

export interface McpServer {
  slug: string;
  name: string;
  icon: string;
  category: McpCategory;
  description: string;
  transport: "stdio" | "sse";
  command: string;
  args: string[];
  env?: Record<string, string>;
  config_required: McpConfigField[];
  official: boolean;
  source_url: string;
  use_cases: string[];
}

export interface McpCatalog {
  version: number;
  categories: McpCategoryDef[];
  servers: McpServer[];
}

interface RawCatalog {
  version?: number;
  categories?: unknown;
  servers?: unknown;
}

/** Lit `_catalog.json` et le valide a minima. */
export async function readMcpCatalog(): Promise<McpCatalog> {
  const file = path.join(TEMPLATES_DIR, "_catalog.json");
  let raw: RawCatalog;
  try {
    const content = await fs.readFile(file, "utf-8");
    raw = JSON.parse(content) as RawCatalog;
  } catch (e) {
    throw new Error(
      `MCP marketplace : impossible de lire ${file} : ${(e as Error).message}`,
    );
  }

  const categories: McpCategoryDef[] = Array.isArray(raw.categories)
    ? raw.categories
        .filter(
          (c): c is { id: string; label?: string; icon?: string } =>
            !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string",
        )
        .map((c) => ({
          id: c.id as McpCategory,
          label: typeof c.label === "string" ? c.label : c.id,
          icon: typeof c.icon === "string" ? c.icon : "📦",
        }))
    : [];

  const servers: McpServer[] = Array.isArray(raw.servers)
    ? raw.servers
        .filter(
          (s): s is Record<string, unknown> =>
            !!s &&
            typeof s === "object" &&
            typeof (s as { slug?: unknown }).slug === "string",
        )
        .map((s) => ({
          slug: String(s.slug),
          name: typeof s.name === "string" ? s.name : String(s.slug),
          icon: typeof s.icon === "string" ? s.icon : "🔌",
          category: (typeof s.category === "string"
            ? s.category
            : "official") as McpCategory,
          description: typeof s.description === "string" ? s.description : "",
          transport: (s.transport === "sse" ? "sse" : "stdio") as "stdio" | "sse",
          command: typeof s.command === "string" ? s.command : "",
          args: Array.isArray(s.args)
            ? (s.args as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
          env: typeof s.env === "object" && s.env !== null
            ? (s.env as Record<string, string>)
            : undefined,
          config_required: Array.isArray(s.config_required)
            ? (s.config_required as unknown[])
                .filter(
                  (c): c is Record<string, unknown> =>
                    !!c && typeof c === "object" &&
                    typeof (c as { key?: unknown }).key === "string",
                )
                .map((c) => ({
                  key: String(c.key),
                  label: typeof c.label === "string" ? c.label : String(c.key),
                  type: (c.type === "secret" ? "secret" : "string") as
                    | "string"
                    | "secret",
                }))
            : [],
          official: s.official === true,
          source_url: typeof s.source_url === "string" ? s.source_url : "",
          use_cases: Array.isArray(s.use_cases)
            ? (s.use_cases as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : [],
        }))
    : [];

  return { version: raw.version || 1, categories, servers };
}
