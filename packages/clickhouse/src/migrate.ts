import type { ClickHouseClient } from "@clickhouse/client";

import { MIGRATIONS } from "./migrations";

const MIGRATIONS_TABLE = "schema_migrations";

async function ensureMigrationsTable(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}
(
  id String,
  applied_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY id`,
  });
}

async function appliedIds(client: ClickHouseClient): Promise<Set<string>> {
  const rs = await client.query({
    query: `SELECT id FROM ${MIGRATIONS_TABLE} FINAL`,
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ id: string }>();
  return new Set(rows.map((r) => r.id));
}

/**
 * A migration boundary, surfaced to `onProgress` so operators can watch a long
 * upgrade advance. `index`/`total` count only the *pending* migrations this run
 * (already-applied ones are skipped before counting), so on a fully-migrated DB
 * no events fire at all.
 */
export type MigrationProgress =
  | { phase: "start"; id: string; index: number; total: number }
  | { phase: "done"; id: string; index: number; total: number; statements: number };

export type RunMigrationsOptions = {
  /** Called at the start and end of each pending migration. */
  onProgress?: (event: MigrationProgress) => void;
};

/**
 * Apply all pending DDL migrations in order. Idempotent: previously-applied
 * ids are skipped and every statement is itself IF NOT EXISTS. Safe to call on
 * every ingest boot and from the docker entrypoint.
 *
 * Not transactional — ClickHouse has no multi-DDL transaction. An id is
 * recorded only after *all* of its statements succeed, so a crash mid-migration
 * leaves that migration un-recorded and the next run retries it from the top;
 * because every statement is individually idempotent, the already-run prefix is
 * a no-op. Recovery is therefore resume-by-retry, not rollback. A failing
 * statement aborts the run with the migration id and statement position, so a
 * partial upgrade is diagnosable rather than a silent half-state.
 */
export async function runMigrations(
  client: ClickHouseClient,
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  await ensureMigrationsTable(client);
  const done = await appliedIds(client);
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  const applied: string[] = [];

  for (let index = 0; index < pending.length; index++) {
    const migration = pending[index]!;
    const total = pending.length;
    options.onProgress?.({ phase: "start", id: migration.id, index, total });
    for (let i = 0; i < migration.statements.length; i++) {
      try {
        await client.command({ query: migration.statements[i]! });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `migration ${migration.id} failed at statement ${i + 1}/${migration.statements.length}: ${message}`,
        );
      }
    }
    await client.insert({
      table: MIGRATIONS_TABLE,
      values: [{ id: migration.id }],
      format: "JSONEachRow",
    });
    applied.push(migration.id);
    options.onProgress?.({
      phase: "done",
      id: migration.id,
      index,
      total,
      statements: migration.statements.length,
    });
  }
  return applied;
}

/**
 * Reassert the per-row spans TTL on boot. Retention is plan-driven via the
 * `retention_days` column (stamped at ingest from the org's plan), so the TTL
 * is a column expression rather than a fixed global window. Idempotent — safe
 * to run on every boot. Self-hosters who want no expiry run with billing off,
 * which stamps an effectively-infinite retention at ingest.
 */
export async function applySpansRetention(
  client: ClickHouseClient,
  /** Optional upper bound in days (RETENTION_DAYS_CAP). Applied in the TTL
   * itself, so rows stamped with a longer retention before the cap existed
   * expire on it too. */
  capDays?: number,
): Promise<void> {
  const days =
    capDays !== undefined && Number.isInteger(capDays) && capDays > 0
      ? `least(retention_days, ${Math.min(capDays, 65535)})`
      : "retention_days";
  await client.command({
    query: `ALTER TABLE spans MODIFY TTL toDateTime(start_time) + toIntervalDay(${days})`,
  });
}
