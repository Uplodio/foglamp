# syntax=docker/dockerfile:1
#
# Multi-target image for the Foglamp self-host stack (see docker-compose.yml).
# Targets:
#   server  — read-heavy Hono/tRPC dashboard API + alert evaluator (tsdown bundle)
#   ingest  — write-heavy span ingestion API (tsdown bundle)
#   migrate — one-shot: Postgres migrate + ClickHouse DDL + seed, then exit
#   web     — Next.js dashboard (next start)
#
# Build a single target:  docker build --target server -t foglamp-server .
# Or let compose build them all:  docker compose build

ARG BUN_VERSION=1.2.19
# Railway: the stage each service runs (server-railway | ingest | web-railway) — see the
# "railway" stages at the end. Global on purpose: an ARG used in a FROM line must
# be declared before the first FROM; Railway injects the service variable here.
ARG RAILWAY_TARGET=web

# ---------- base: install the whole workspace once (lockfile-pinned) ----------
# .dockerignore keeps node_modules/dist/.next/.env out of the build context.
FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# ---------- server ----------
# tsdown inlines the @foglamp/* workspace packages; external npm deps
# (hono, better-auth, @trpc/server, pg, …) stay in node_modules.
FROM base AS server-build
# Build the foglamp SDK too — it's a runtime workspace dep of the server
# (foggy.ts dogfooding) and its exports resolve to dist/.
RUN bun run --filter foglamp build && bun run --filter server build

FROM oven/bun:${BUN_VERSION}-slim AS server
WORKDIR /app
ENV NODE_ENV=production
COPY --from=server-build /app/node_modules ./node_modules
# node_modules/foglamp is a workspace symlink to packages/sdk (imported by
# foggy.ts for dogfooding) — copy the target or the symlink dangles at runtime.
COPY --from=server-build /app/packages/sdk ./packages/sdk
COPY --from=server-build /app/apps/server/dist ./apps/server/dist
COPY --from=server-build /app/apps/server/package.json ./apps/server/package.json
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "run", "apps/server/dist/main.mjs"]

# ---------- ingest ----------
FROM base AS ingest-build
RUN bun run --filter ingest build

FROM oven/bun:${BUN_VERSION}-slim AS ingest
WORKDIR /app
ENV NODE_ENV=production
COPY --from=ingest-build /app/node_modules ./node_modules
COPY --from=ingest-build /app/apps/ingest/dist ./apps/ingest/dist
COPY --from=ingest-build /app/apps/ingest/package.json ./apps/ingest/package.json
ENV INGEST_PORT=4000
EXPOSE 4000
USER bun
CMD ["bun", "run", "apps/ingest/dist/main.mjs"]

# ---------- migrate (one-shot bootstrap) ----------
# Runs from source in the full image so it has the drizzle migrations, the CH
# DDL runner, and the seed script. Exits 0 on success; compose gates the app
# tiers on its completion.
FROM base AS migrate
WORKDIR /app/apps/server
ENV NODE_ENV=production
CMD ["bun", "run", "scripts/docker-bootstrap.ts"]

# ---------- web ----------
# NEXT_PUBLIC_* are baked into the client bundle at build time, so they must be
# the browser-facing URLs (passed as build args by compose). INTERNAL_SERVER_URL
# is supplied at runtime for the SSR session gate to reach the server service.
FROM base AS web
ARG NEXT_PUBLIC_SERVER_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_URL=http://localhost:3001
ENV NEXT_PUBLIC_SERVER_URL=${NEXT_PUBLIC_SERVER_URL}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
RUN bun run --filter web build
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["bun", "run", "start"]

# ---------- hud-demo (hosted live HUD example) ----------
# The Vite app (which imports `foglamp/hud`) + a Bun server that runs mock agents
# and proxies the loopback HUD broker's SSE onto its own origin. Build foglamp
# first so `foglamp/hud` resolves to dist/ during the Vite build.
FROM base AS hud-demo-build
RUN bun run --filter foglamp build \
 && bun run --filter foglamp-example-hud-demo build

FROM oven/bun:${BUN_VERSION}-slim AS hud-demo
WORKDIR /app
# NOT production: foglamp's HUD is gated to non-production runtimes, so the broker
# only starts when NODE_ENV !== "production". (Cloud Run: deploy single-instance
# with CPU always allocated so the broker + heartbeat keep running.)
ENV NODE_ENV=development
COPY --from=hud-demo-build /app/node_modules ./node_modules
# node_modules/foglamp is a workspace symlink to packages/sdk — copy the target
# (incl. its dist/, with the lazy HUD broker chunk) or the symlink dangles.
COPY --from=hud-demo-build /app/packages/sdk ./packages/sdk
COPY --from=hud-demo-build /app/examples/hud-demo/dist ./examples/hud-demo/dist
COPY --from=hud-demo-build /app/examples/hud-demo/src ./examples/hud-demo/src
COPY --from=hud-demo-build /app/examples/hud-demo/package.json ./examples/hud-demo/package.json
ENV PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "run", "examples/hud-demo/src/server.ts"]

# ---------- railway: one Railway service per stage, picked by a build arg ----------
# Railway builds the LAST stage of a Dockerfile and has no --target option, but it
# injects service variables as build args when they are declared with ARG. Each
# Railway service sets RAILWAY_TARGET to the stage it runs (server-railway, ingest,
# web-railway). See .railway/railway.ts.
#
# server-railway keeps the full workspace (unlike the slim `server` stage) so the
# one-shot bootstrap can run as Railway's pre-deploy command on every deploy:
#   bun run apps/server/scripts/docker-bootstrap.ts   (migrate + CH DDL + seed; idempotent)
FROM server-build AS server-railway
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "run", "apps/server/dist/main.mjs"]

# web-railway: the upstream web stage plus the SDK build it needs — the dashboard
# imports foglamp/hud, whose package exports resolve to packages/sdk/dist.
FROM base AS web-railway
ARG NEXT_PUBLIC_SERVER_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_URL=http://localhost:3001
ENV NEXT_PUBLIC_SERVER_URL=${NEXT_PUBLIC_SERVER_URL}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
RUN bun run --filter foglamp build && bun run --filter web build
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["bun", "run", "start"]

FROM ${RAILWAY_TARGET} AS railway
