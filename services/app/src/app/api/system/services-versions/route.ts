/**
 * GET /api/system/services-versions
 *
 * Pour chaque service Docker tiers (Dify, n8n, Qdrant, Authentik,
 * Ollama, Langfuse), compare la version actuelle (lue depuis l'env
 * .env du serveur) avec la dernière release stable disponible sur
 * GitHub.
 *
 * Réponse :
 *   {
 *     services: [{
 *       slug, name, current, latest, github_repo,
 *       up_to_date: boolean,
 *       latest_published_at: string,
 *       release_url: string,
 *       error?: string,
 *     }],
 *     fetched_at: ISO string,
 *   }
 *
 * Pour cette V1 : info-only (pas de bouton « Mettre à jour »). L'admin
 * change manuellement la version dans .env puis redéploie. La V2
 * ajoutera le bouton qui patch .env + redémarre via le watcher hôte.
 *
 * Cache 30 min côté serveur pour éviter de spammer GitHub Releases API
 * (60 req/h non authentifié).
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface ServiceConfig {
  slug: string;
  name: string;
  /** Variable d'env qui contient la version actuelle (ex: DIFY_VERSION). */
  envVar: string;
  /** Repo GitHub `owner/repo` pour query /releases/latest. */
  githubRepo: string;
  /** Préfixe à strip du tag GitHub avant comparaison (ex: "v" pour qdrant). */
  tagPrefix?: string;
}

const SERVICES: ServiceConfig[] = [
  { slug: "dify",       name: "Dify",       envVar: "DIFY_VERSION",       githubRepo: "langgenius/dify" },
  { slug: "qdrant",     name: "Qdrant",     envVar: "QDRANT_VERSION",     githubRepo: "qdrant/qdrant",       tagPrefix: "v" },
  { slug: "authentik",  name: "Authentik",  envVar: "AUTHENTIK_VERSION",  githubRepo: "goauthentik/authentik" },
  { slug: "n8n",        name: "n8n",        envVar: "N8N_VERSION",        githubRepo: "n8n-io/n8n",           tagPrefix: "n8n@" },
  { slug: "ollama",     name: "Ollama",     envVar: "OLLAMA_VERSION",     githubRepo: "ollama/ollama",        tagPrefix: "v" },
  { slug: "langfuse",   name: "Langfuse",   envVar: "LANGFUSE_VERSION",   githubRepo: "langfuse/langfuse",    tagPrefix: "v" },
];

interface CacheEntry {
  fetchedAt: number;
  data: unknown;
}
let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

interface GithubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

async function fetchLatestRelease(repo: string): Promise<GithubRelease | null> {
  // /releases/latest renvoie la dernière non-prerelease, non-draft
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "BoxIA-update-checker",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers, signal: AbortSignal.timeout(8_000) },
    );
    if (!r.ok) return null;
    return (await r.json()) as GithubRelease;
  } catch {
    return null;
  }
}

function normalizeVersion(v: string, prefix?: string): string {
  if (!v) return "";
  let out = v.trim();
  if (prefix && out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

function compareVersions(current: string, latest: string): boolean {
  // up_to_date si current >= latest. On compare de façon naïve (string
  // compare) parce que les versions sont en general bien formatées.
  // Pour Dify "1.10.1" vs "1.11.0" : split par "." + numérique compare.
  const a = current.split(".").map((x) => parseInt(x.replace(/[^\d].*$/, ""), 10) || 0);
  const b = latest.split(".").map((x) => parseInt(x.replace(/[^\d].*$/, ""), 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Cache hit ?
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    const cached = _cache.data as Record<string, unknown>;
    return NextResponse.json({ ...cached, cached: true });
  }

  // Fetch en parallèle
  const services = await Promise.all(SERVICES.map(async (s) => {
    const current = process.env[s.envVar] || "";
    const release = await fetchLatestRelease(s.githubRepo);
    if (!release) {
      return {
        slug: s.slug,
        name: s.name,
        current,
        latest: null,
        github_repo: s.githubRepo,
        up_to_date: null,
        latest_published_at: null,
        release_url: `https://github.com/${s.githubRepo}/releases`,
        error: "github_fetch_failed",
      };
    }
    const latestNorm = normalizeVersion(release.tag_name, s.tagPrefix);
    const currentNorm = normalizeVersion(current, s.tagPrefix);
    return {
      slug: s.slug,
      name: s.name,
      current: currentNorm,
      latest: latestNorm,
      github_repo: s.githubRepo,
      up_to_date: current ? compareVersions(currentNorm, latestNorm) : null,
      latest_published_at: release.published_at,
      release_url: release.html_url,
      release_name: release.name,
      error: null,
    };
  }));

  const data = {
    services,
    fetched_at: new Date().toISOString(),
    total: services.length,
    outdated: services.filter((s) => s.up_to_date === false).length,
  };
  _cache = { fetchedAt: Date.now(), data };
  return NextResponse.json({ ...data, cached: false });
}
