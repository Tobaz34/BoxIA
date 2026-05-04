# =============================================================================
# AI Box App — Next.js 15 production build
# =============================================================================

# ---- Stage 1 : deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --no-audit --no-fund

# ---- Stage 2 : build ----
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-args pour version.json (cf. scripts/gen-version.mjs)
# Si .git n'est pas accessible (cas COPY . . sans le dossier .git),
# on utilise ces vars d'env comme fallback. Le compose passe ces args
# via build.args : BUILD_COMMIT_SHA, BUILD_COMMIT_DATE, BUILD_BRANCH.
ARG BUILD_COMMIT_SHA=""
ARG BUILD_COMMIT_DATE=""
ARG BUILD_COMMIT_MESSAGE=""
ARG BUILD_BRANCH=""
ENV BUILD_COMMIT_SHA=$BUILD_COMMIT_SHA
ENV BUILD_COMMIT_DATE=$BUILD_COMMIT_DATE
ENV BUILD_COMMIT_MESSAGE=$BUILD_COMMIT_MESSAGE
ENV BUILD_BRANCH=$BUILD_BRANCH
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Stage 3 : runner (image finale légère) ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# python3 nécessaire pour /api/bench/run qui spawn le runner Python
# (tools/bench/run-bench.py monté en /repo via compose). +9 MB sur
# l'image — acceptable pour ne pas avoir un sidecar bench dédié.
RUN apk add --no-cache python3

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Output standalone Next.js (next.config.mjs : output: "standalone")
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
