/**
 * GET /api/system/check-updates — compare le commit local au tip de main
 *                                  via l'API GitHub publique.
 *
 * Public (info utile au support) mais cap à 1 appel / 30s côté serveur pour
 * éviter de cramer le rate-limit GitHub (60/h sans auth).
 *
 * Réponse :
 *   { up_to_date: boolean,
 *     behind_count: number,
 *     local_sha: string,
 *     remote_sha: string,
 *     commits: [{ sha, short, date, author, message }],
 *     error?: string }
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getActiveGitHubToken } from "@/lib/github-token";

export const dynamic = "force-dynamic";

const REPO = process.env.AIBOX_REPO_SLUG || "Tobaz34/BoxIA";
// Branche par défaut si version.json n'a pas de branch (build sans
// BUILD_BRANCH = info perdue). Comparaison toujours contre main pour
// éviter de coincer un client sur une feature branch oubliée.
const FALLBACK_BRANCH = process.env.AIBOX_REPO_BRANCH || "main";

const VERSION_JSON_PATHS = [
  path.join(process.cwd(), "public", "version.json"),
  path.join(process.cwd(), ".next", "static", "version.json"),
];

interface VersionInfo {
  commit_sha?: string;
  commit_short?: string;
  branch?: string;
}

let cache: { fetched_at: number; payload: unknown } | null = null;
const CACHE_MS = 30_000;

async function readLocalVersion(): Promise<VersionInfo> {
  for (const p of VERSION_JSON_PATHS) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      // try next
    }
  }
  return {};
}

async function fetchGithubCommits(branch: string, token: string | null): Promise<{ sha: string; commit: { author: { date: string; name: string }; message: string } }[]> {
  const url = `https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(branch)}&per_page=20`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "aibox-app/check-updates",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(url, { headers, cache: "no-store" });
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status}: ${await r.text().catch(() => "")}`);
  }
  return r.json();
}

export async function GET() {
  if (cache && Date.now() - cache.fetched_at < CACHE_MS) {
    return NextResponse.json(cache.payload);
  }

  const local = await readLocalVersion();
  const localSha = (local.commit_sha || "").trim();
  const branch = (local.branch || FALLBACK_BRANCH).trim() || FALLBACK_BRANCH;

  // Token GitHub : sans token sur repo privé, GitHub renvoie 404 ; sur
  // repo public, marche mais limité à 60/h. Avec token, 5000/h.
  const active = await getActiveGitHubToken();
  if (!active) {
    return NextResponse.json({
      error: "no_github_token",
      hint: "Connecte un token GitHub dans /settings (carte Connexion GitHub)",
      up_to_date: false,
      behind_count: 0,
      local_sha: localSha,
      remote_sha: "",
    });
  }

  let payload: unknown;
  try {
    const commits = await fetchGithubCommits(branch, active.token);
    if (commits.length === 0) {
      payload = { error: "no_commits_found", up_to_date: true, behind_count: 0, local_sha: localSha, remote_sha: "" };
    } else {
      const remoteSha = commits[0].sha;
      const idx = localSha
        ? commits.findIndex((c) => c.sha === localSha || c.sha.startsWith(localSha))
        : -1;
      // idx = 0 → up-to-date
      // idx > 0 → derrière de idx commits
      // idx = -1 → soit on est plus récent (peu probable), soit le commit local est >20 commits derrière
      const upToDate = idx === 0;
      const behindCount = idx > 0 ? idx : (idx === -1 && localSha ? -1 : 0);
      payload = {
        up_to_date: upToDate,
        behind_count: behindCount,
        local_sha: localSha,
        remote_sha: remoteSha,
        commits: commits.slice(0, idx > 0 ? idx : 5).map((c) => ({
          sha: c.sha,
          short: c.sha.slice(0, 7),
          date: c.commit.author.date,
          author: c.commit.author.name,
          message: c.commit.message.split("\n")[0],
        })),
      };
    }
  } catch (e) {
    payload = {
      error: String(e instanceof Error ? e.message : e),
      up_to_date: false,
      behind_count: 0,
      local_sha: localSha,
      remote_sha: "",
    };
  }

  cache = { fetched_at: Date.now(), payload };
  return NextResponse.json(payload);
}
