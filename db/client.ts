/**
 * Database access.
 * - DATABASE_URL set  → real Postgres (Supabase / Docker) via postgres-js.
 * - DATABASE_URL unset → embedded Postgres (PGlite, a real Postgres compiled to WASM) stored in
 *   PGLITE_DIR (default ./node_modules/.cache/bba-pglite). It is migrated and seeded automatically on first use, so the
 *   demo runs with zero setup. PGlite is single-process: use DATABASE_URL for Vercel/production.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { runMigrations } from "./migrate";

/** Inside node_modules/.cache so the dev server's file watcher ignores it. */
export const DEFAULT_PGLITE_DIR = "./node_modules/.cache/bba-pglite";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or a transaction. */
export type Queryable = DB | Tx;

type Holder = { db?: Promise<DB>; override?: DB; close?: () => Promise<void> };
const g = globalThis as unknown as { __bbaDb?: Holder };
const holder: Holder = (g.__bbaDb ??= {});

export async function getDb(): Promise<DB> {
  if (holder.override) return holder.override;
  holder.db ??= connect().catch((e) => {
    holder.db = undefined;
    throw e;
  });
  return holder.db;
}

async function connect(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 5), prepare: false });
    holder.close = async () => client.end();
    return drizzle(client, { schema });
  }
  const { db, close } = await createPgliteDb(process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR);
  holder.close = close;
  const { autoSeedIfEmpty } = await import("./seed");
  await autoSeedIfEmpty(db);
  return db;
}

/** Creates a PGlite-backed database (pass "memory://" for an in-memory one) and runs migrations. */
export async function createPgliteDb(dataDir: string): Promise<{ db: DB; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const { drizzle } = await import("drizzle-orm/pglite");
  if (!dataDir.includes("://")) (await import("node:fs")).mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir, { extensions: { btree_gist } });
  await runMigrations((q) => client.exec(q), async (q, params) => (await client.query(q, params)).rows as Record<string, unknown>[]);
  const db = drizzle(client, { schema }) as unknown as DB;
  return { db, close: () => client.close() };
}

/** Test helper: route every getDb() call to the given database. */
export function setDbOverride(db: DB | undefined) {
  holder.override = db;
}

export async function closeDb() {
  await holder.close?.();
  holder.db = undefined;
  holder.close = undefined;
}

/** Postgres SQLSTATE of an error thrown by either driver (Drizzle may wrap it in `cause`). */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";

export { schema };
