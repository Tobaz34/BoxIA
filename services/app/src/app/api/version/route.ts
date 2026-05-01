/**
 * GET /api/version — version courante + extrait du changelog.
 *
 * Lit `public/version.json` (généré au build par scripts/gen-version.mjs)
 * et `/CHANGELOG.md` (bind-mounté depuis le repo). Si l'un manque, on
 * renvoie ce qu'on a + une note `incomplete: true`.
 *
 * Pas d'auth requise : info publique côté UI (utile au support).
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

interface VersionInfo {
  app_version: string;
  build_date: string;
  commit_sha: string;
  commit_short: string;
  commit_date: string;
  commit_message: string;
  branch: string;
}

interface ChangelogEntry {
  version: string;
  date: string;
  raw: string; // markdown brut
}

const VERSION_JSON_PATHS = [
  // Standalone Next.js : public est copié dans /app/public au runtime
  path.join(process.cwd(), "public", "version.json"),
  // Fallback dev
  path.join(process.cwd(), ".next", "static", "version.json"),
];

const CHANGELOG_PATHS = [
  "/CHANGELOG.md", // bind mount prod
  path.join(process.cwd(), "..", "..", "CHANGELOG.md"), // dev
  path.join(process.cwd(), "CHANGELOG.md"),
];

async function readVersion(): Promise<VersionInfo | null> {
  for (const p of VERSION_JSON_PATHS) {
    try {
      const content = await fs.readFile(p, "utf-8");
      return JSON.parse(content) as VersionInfo;
    } catch {
      continue;
    }
  }
  return null;
}

async function readChangelog(): Promise<string | null> {
  for (const p of CHANGELOG_PATHS) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse les sections `## [version] — date` du markdown. */
function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  // Pattern : "## [0.2.0] — 2026-05-01" (ou "—" remplaçable par "-")
  const re = /^##\s+\[([^\]]+)\]\s*[—-]\s*([^\n]+?)\s*$/gm;
  const matches: { version: string; date: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    matches.push({ version: m[1], date: m[2], offset: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].offset;
    const end = i + 1 < matches.length ? matches[i + 1].offset : md.length;
    const raw = md.slice(start, end).trim();
    entries.push({
      version: matches[i].version,
      date: matches[i].date,
      raw,
    });
  }
  return entries;
}

export async function GET() {
  const version = await readVersion();
  const md = await readChangelog();
  const changelog = md ? parseChangelog(md) : [];

  return NextResponse.json({
    incomplete: !version || !md,
    version: version || {
      app_version: "unknown",
      build_date: "",
      commit_sha: "",
      commit_short: "",
      commit_date: "",
      commit_message: "",
      branch: "",
    },
    // On limite à 5 entrées pour ne pas exploser le JSON. L'admin peut
    // toujours consulter CHANGELOG.md sur GitHub pour l'historique complet.
    changelog: changelog.slice(0, 5),
  });
}
