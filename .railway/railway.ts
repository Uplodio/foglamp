// Foglamp self-host on Railway — the whole stack as code (`railway config plan` / `apply`).
//
// Secrets are never written here. BETTER_AUTH_SECRET, FOGLAMP_SECRETS_KEY, ADMIN_EMAIL,
// ADMIN_PASSWORD and CLICKHOUSE_PASSWORD are set once with `railway variable set --stdin`
// and preserve()'d, so re-applying never touches them.
//
// Public URLs resolve through Railway variable templates once each app service has a
// Railway-generated domain (`railway domain --service <name>`), so nothing is hardcoded.
// The app services build from the fork's Dockerfile; RAILWAY_TARGET picks the stage
// (see the "railway" stages at the end of ../Dockerfile).
import { defineRailway, github, image, postgres, preserve, project, service, volume } from "railway/iac";

const REPO = "Uplodio/foglamp";
const BRANCH = "railway";
const dockerfile = { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" };

export default defineRailway(() => {
  // Organizations, projects, API keys, alerts.
  const db = postgres("postgres");

  // Span store. Private network only (no domain); the image listens on IPv6.
  const clickhouse = service("clickhouse", {
    source: image("clickhouse/clickhouse-server:24.8-alpine"),
    env: {
      CLICKHOUSE_DB: "foglamp",
      CLICKHOUSE_USER: "default",
      CLICKHOUSE_PASSWORD: preserve(),
    },
    volumeMounts: { "/var/lib/clickhouse": volume("clickhouse-data") },
  });

  // Shared by server + ingest — the compose file's x-app-env.
  const appEnv = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    BETTER_AUTH_URL: "https://${{server.RAILWAY_PUBLIC_DOMAIN}}",
    CORS_ORIGIN: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
    CLICKHOUSE_URL: "http://${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123",
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_PASSWORD: "${{clickhouse.CLICKHOUSE_PASSWORD}}",
    CLICKHOUSE_DATABASE: "foglamp",
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
    env: {
      ...appEnv,
      RAILWAY_TARGET: "server-railway",
      PORT: "3000",
      BETTER_AUTH_SECRET: preserve(),
      FOGLAMP_SECRETS_KEY: preserve(),
      ADMIN_EMAIL: preserve(),
      ADMIN_PASSWORD: preserve(),
    },
  });

  // Span ingestion — what FOGLAMP_INGEST_URL points at (…/ingest).
  const ingest = service("ingest", {
    source: github(REPO, { branch: BRANCH }),
    build: dockerfile,
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
    env: {
      NODE_ENV: "production",
      RAILWAY_TARGET: "web",
      PORT: "3001",
      NEXT_PUBLIC_SERVER_URL: "https://${{server.RAILWAY_PUBLIC_DOMAIN}}",
      NEXT_PUBLIC_APP_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
    },
  });

  return project("foglamp", { resources: [db, clickhouse, server, ingest, web] });
});
