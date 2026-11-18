/**
 * npm run db:migrate | db:seed | db:reset
 * Uses DATABASE_URL (Postgres) when set, otherwise the embedded PGlite database in PGLITE_DIR.
 * Stop the dev server before running these against PGlite (it allows a single process).
 */
import { rm } from "node:fs/promises";
import { count } from "drizzle-orm";
import { runMigrations } from "./migrate";
import * as schema from "./schema";
import { DEFAULT_PGLITE_DIR, type DB } from "./client";

async function loadEnvFile() {
  try {
    const { readFileSync } = await import("node:fs");
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env */
  }
}

async function open(): Promise<{ db: DB; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const ran = await runMigrations((q) => client.unsafe(q), async (q, p) => (await client.unsafe(q, p as never[])) as unknown as Record<string, unknown>[]);
    if (ran.length) console.log("Applied migrations:", ran.join(", "));
    return { db: drizzle(client, { schema }) as unknown as DB, close: () => client.end() };
  }
  const { createPgliteDb } = await import("./client");
  return createPgliteDb(process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR);
}

async function main() {
  await loadEnvFile();
  const cmd = process.argv[2];
  if (cmd === "reset") {
    if (process.env.DATABASE_URL) {
      const { default: postgres } = await import("postgres");
      const client = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
      await client.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
      await client.end();
    } else {
      await rm(process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR, { recursive: true, force: true });
    }
    console.log("Database reset.");
  }
  const { db, close } = await open();
  console.log("Migrations up to date.");
  if (cmd === "seed" || cmd === "reset") {
    const [{ n }] = await db.select({ n: count() }).from(schema.sports);
    if (n > 0) console.log("Database already has data; skipping seed (use db:reset to start fresh).");
    else {
      const { seedDatabase } = await import("./seed");
      console.log("Seeded:", await seedDatabase(db));
    }
  }
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
