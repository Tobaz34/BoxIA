// Génère public/version.json au moment du build.
// Source : package.json + git log + date courante.
//
// Pourquoi : on veut afficher dans /settings une carte « Version & mises
// à jour » qui montre quel build tourne actuellement (utile au support
// pour reproduire un bug et au client pour savoir s'il a la dernière maj).
//
// Si .git n'est pas accessible (cas Docker build sans le repo), on
// retombe sur les variables d'env BUILD_COMMIT_SHA / BUILD_COMMIT_DATE
// passées via --build-arg du Dockerfile.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

// Tente de lire git, sinon fallback sur env vars du Dockerfile
const commitSha =
  safeExec("git rev-parse HEAD") ||
  process.env.BUILD_COMMIT_SHA ||
  "unknown";
const commitShort = commitSha.slice(0, 7);

const commitDate =
  safeExec("git log -1 --format=%cI") ||
  process.env.BUILD_COMMIT_DATE ||
  "";

const commitMessage =
  safeExec("git log -1 --format=%s") ||
  process.env.BUILD_COMMIT_MESSAGE ||
  "";

const branch =
  safeExec("git rev-parse --abbrev-ref HEAD") ||
  process.env.BUILD_BRANCH ||
  "";

const version = {
  app_version: pkg.version,
  build_date: new Date().toISOString(),
  commit_sha: commitSha,
  commit_short: commitShort,
  commit_date: commitDate,
  commit_message: commitMessage,
  branch,
};

const publicDir = join(ROOT, "public");
mkdirSync(publicDir, { recursive: true });
const out = join(publicDir, "version.json");
writeFileSync(out, JSON.stringify(version, null, 2));
console.log(`[gen-version] wrote ${out}`);
console.log(`  v${version.app_version}  ${commitShort}  (${branch})`);
