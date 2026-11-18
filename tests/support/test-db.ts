/**
 * Test database factory.
 * - TEST_DATABASE_URL unset → in-memory PGlite (fast, but one connection: queries never overlap).
 * - TEST_DATABASE_URL set   → a real Postgres with a 25-connection pool, in a fresh schema per
 *   test (migrated, then dropped). Used by `npm run test:concurrency` so races truly run in parallel.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgliteDb, type DB } from "@/db/client";
import * as schema from "@/db/schema";
import { runMigrations } from "@/db/migrate";

export type TestDb = {
  db: DB;
  kind: "pglite" | "postgres";
  close: () => Promise<void>;
  /** postgres-js connection ids that ran queries (proves real parallelism). */
  connectionIds: Set<number>;
  /** Raw query helper that returns rows on either driver. */
  rows: (sqlText: string) => Promise<Record<string, unknown>[]>;
  /**
   * Runs `fn` while a separate monitor connection samples pg_stat_activity every few ms and
   * records the most backends of this database that were busy (active or mid-transaction) at
   * the same moment. maxBusy > 1 proves the work really overlapped. PGlite always reports 1.
   */
  overlap: <T>(fn: () => Promise<T>) => Promise<{ result: T; maxBusy: number }>;
};

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", "postgres"];

/** Refuses anything that could be a production database. */
export function assertSafeTestUrl(url: string, env: Record<string, string | undefined> = process.env) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  if (env.DATABASE_URL && env.DATABASE_URL === url) throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  if (env.NODE_ENV === "production") throw new Error("Refusing to run database tests with NODE_ENV=production");
  const allowed = [...DEFAULT_ALLOWED_HOSTS, ...(env.TEST_DB_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)];
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!allowed.includes(host)) {
    throw new Error(`TEST_DATABASE_URL host "${host}" is not in the allowlist. Add it to TEST_DB_ALLOWED_HOSTS if it is a staging/test database.`);
  }
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { db, close } = await createPgliteDb("memory://");
    return {
      db,
      kind: "pglite",
      close,
      connectionIds: new Set([0]),
      rows: async (q) => {
        const r = (await db.execute(q as never)) as unknown as { rows: Record<string, unknown>[] };
        return r.rows;
      },
      overlap: async (fn) => ({ result: await fn(), maxBusy: 1 }),
    };
  }
  assertSafeTestUrl(url);
  const schemaName = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public`).catch(() => {});
  await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await admin.end();

  const connectionIds = new Set<number>();
  const client = postgres(url, {
    max: 25,
    prepare: false,
    onnotice: () => {},
    connection: { search_path: `${schemaName},public` },
    debug: (connection: number) => {
      connectionIds.add(connection);
    },
  });
  await runMigrations(
    (q) => client.unsafe(q),
    async (q, p) => (await client.unsafe(q, p as never[])) as unknown as Record<string, unknown>[],
  );
  // Open the pool's connections up front so even tiny bursts run on many backends at once.
  await Promise.all(Array.from({ length: 20 }, () => client.unsafe("select pg_sleep(0.05)")));
  connectionIds.clear();
  const db = drizzle(client, { schema }) as unknown as DB;
  return {
    db,
    kind: "postgres",
    connectionIds,
    rows: async (q) => (await client.unsafe(q)) as unknown as Record<string, unknown>[],
    overlap: async (fn) => {
      const monitor = postgres(url, { max: 1, onnotice: () => {} });
      const sample = async () => {
        const [r] = await monitor.unsafe(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and state in ('active', 'idle in transaction', 'idle in transaction (aborted)')`,
        );
        return (r as unknown as { n: number }).n;
      };
      await sample(); // connect + warm up before the burst starts, so no short burst is missed
      let maxBusy = 0;
      let running = true;
      const sampler = (async () => {
        while (running) maxBusy = Math.max(maxBusy, await sample()); // back-to-back, ~1 ms per sample
      })();
      try {
        const result = await fn();
        return { result, maxBusy };
      } finally {
        running = false;
        await sampler.catch(() => {});
        await monitor.end();
      }
    },
    close: async () => {
      await client.end({ timeout: 5 });
      const a = postgres(url, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await a.end();
    },
  };
}
