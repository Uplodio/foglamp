// Foglamp self-host on Railway — the whole stack as code (`railway config plan` / `apply`).
//
// Secrets are never written here. BETTER_AUTH_SECRET, FOGLAMP_SECRETS_KEY, ADMIN_EMAIL,
// ADMIN_PASSWORD and CLICKHOUSE_PASSWORD are set once with `railway variable set --stdin`
// and preserve()'d, so re-applying never touches them.
//
// Public URLs are the custom domains under uplodio.com. They must be real hostnames
// (not Railway's generated ones): the server stamps its session cookie with the
// dashboard's hostname as the cookie Domain, which browsers only accept when the API
// host is a subdomain of it — api.foglamp.uplodio.com under foglamp.uplodio.com.
// The app services build from the fork's Dockerfile; RAILWAY_TARGET picks the stage
// (see the "railway" stages at the end of ../Dockerfile).
import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

const REPO = "Uplodio/foglamp";
const BRANCH = "railway";
const dockerfile = { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" };
const WEB_HOST = "foglamp.uplodio.com";
const API_HOST = "api.foglamp.uplodio.com";
const INGEST_HOST = "ingest.foglamp.uplodio.com";

export default defineRailway(() => {
  // Organizations, projects, API keys, alerts.
  const db = postgres("postgres");

  // Span store. Private network only (no domain); the image listens on IPv6.
  const clickhouse = service("clickhouse", {
    // The stock 24.8 image plus clickhouse/config.d + users.d (low-memory config:
    // no unread internal log tables, small caches, pools sized for 2 vCPU) — see
    // clickhouse/Dockerfile. Railway bills held memory; the defaults were the bill.
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "DOCKERFILE" as const, dockerfilePath: "clickhouse/Dockerfile" },
    // ClickHouse sizes its thread pools and per-query max_threads from the container's
    // CPU limit. Unlimited (24 vCPU here) made one dashboard page load — nine parallel
    // queries — exhaust the container's thread budget (CANNOT_SCHEDULE_TASK, code 439).
    // 2 vCPU / 2 GB: with the low-memory config the server stays well under 1 GB, and
    // max_server_memory_usage_to_ram_ratio (0.75) fails a runaway query at ~1.5 GB.
    deploy: { limitOverride: { containers: { cpu: 2, memoryBytes: 2 * 1024 * 1024 * 1024 } } },
    env: {
      CLICKHOUSE_DB: "foglamp",
      CLICKHOUSE_USER: "default",
      CLICKHOUSE_PASSWORD: preserve(),
    },
    // Size and region pinned to the live volume: omitting them makes `config apply`
    // plan a destructive null-out of both and refuse the whole run.
    volumeMounts: {
      "/var/lib/clickhouse": volume("clickhouse-data", { sizeMB: 50000, region: "europe-west4-drams3a" }),
    },
  });

  // Shared by server + ingest — the compose file's x-app-env.
  const appEnv = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    BETTER_AUTH_URL: `https://${API_HOST}`,
    CORS_ORIGIN: `https://${WEB_HOST}`,
    CLICKHOUSE_URL: "http://${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123",
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_PASSWORD: "${{clickhouse.CLICKHOUSE_PASSWORD}}",
    CLICKHOUSE_DATABASE: "foglamp",
    // Span retention: ~6 months, then ClickHouse deletes them. Stamped at ingest and
    // applied as a cap in the spans TTL on boot, so it covers stored rows too.
    RETENTION_DAYS_CAP: "183",
    // Email is optional (password login works without it); empty mirrors docker-compose.
    RESEND_API_KEY: "",
    RESEND_FROM_EMAIL: "",
  };

  // Dashboard API + auth + alert cron. The pre-deploy runs the one-shot bootstrap
  // (Postgres migrations, ClickHouse DDL, admin seed — idempotent) before every deploy.
  const server = service("server", {
    source: github(REPO, { branch: BRANCH }),
    build: dockerfile,
    preDeploy: "bun run apps/server/scripts/docker-bootstrap.ts",
    domains: [{ domain: API_HOST, port: 3000 }],
    env: {
      ...appEnv,
      RAILWAY_TARGET: "server-railway",
      PORT: "3000",
      BETTER_AUTH_SECRET: preserve(),
      FOGLAMP_SECRETS_KEY: preserve(),
      ADMIN_EMAIL: preserve(),
      ADMIN_PASSWORD: preserve(),
      // Foggy's model key (OpenAI, gpt-6-luna) — set by hand, never re-applied.
      OPENAI_API_KEY: preserve(),
    },
  });

  // Span ingestion — what FOGLAMP_INGEST_URL points at (…/ingest).
  const ingest = service("ingest", {
    source: github(REPO, { branch: BRANCH }),
    build: dockerfile,
    domains: [{ domain: INGEST_HOST, port: 4000 }],
    env: {
      ...appEnv,
      RAILWAY_TARGET: "ingest",
      PORT: "4000",
      INGEST_PORT: "4000",
      BETTER_AUTH_SECRET: "${{server.BETTER_AUTH_SECRET}}",
    },
  });

  // Next.js dashboard. NEXT_PUBLIC_* are baked in at build time (declared as ARGs in
  // the Dockerfile's web stage), so this service must be rebuilt after domains change.
  const web = service("web", {
    source: github(REPO, { branch: BRANCH }),
    build: dockerfile,
    domains: [{ domain: WEB_HOST, port: 3001 }],
    env: {
      NODE_ENV: "production",
      RAILWAY_TARGET: "web-railway",
      PORT: "3001",
      NEXT_PUBLIC_SERVER_URL: `https://${API_HOST}`,
      NEXT_PUBLIC_APP_URL: `https://${WEB_HOST}`,
      // SSR session gate: the web container calls the API over the private network.
      // It must NOT go through a public hostname — the gate forwards the browser's
      // Host header, Bun's fetch sends it, and Railway's edge routes by Host, so the
      // call would land on this web service and return HTML instead of a session.
      INTERNAL_SERVER_URL: "http://${{server.RAILWAY_PRIVATE_DOMAIN}}:3000",
    },
  });

  return project("foglamp", { resources: [db, clickhouse, server, ingest, web] });
});
