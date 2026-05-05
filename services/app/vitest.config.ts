/**
 * Vitest config — tests unitaires des libs critiques BoxIA.
 *
 * Tests ciblés sur les libs sans dépendance Next.js / DB / réseau pour
 * pouvoir tourner offline et rapidement. Les routes API et composants
 * UI sont testés via E2E Chrome MCP (cf tools/research/TEST-PLAN-AFTER-DEPLOY.md).
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false, // import explicite { describe, it, expect } de vitest
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
