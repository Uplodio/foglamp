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
import { defineRailway, github, image, postgres, preserve, project, service, volume } from "railway/iac";

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
    BETTER_AUTH_URL: `https://${API_HOST}`,
    CORS_ORIGIN: `https://${WEB_HOST}`,
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
    domains: [{ domain: API_HOST, port: 3000 }],
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
    },
  });

  return project("foglamp", { resources: [db, clickhouse, server, ingest, web] });
});
