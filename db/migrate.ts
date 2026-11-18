/**
 * Tiny SQL migration runner: applies db/migrations/*.sql in filename order, once each.
 * Works with both PGlite and postgres-js via two callbacks.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type Exec = (sql: string) => Promise<unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export function migrationsDir() {
  return path.join(process.cwd(), "db", "migrations");
}

export async function runMigrations(exec: Exec, query: Query): Promise<string[]> {
  await exec(`CREATE TABLE IF NOT EXISTS "_migrations" ("name" text PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await query(`SELECT "name" FROM "_migrations"`)).map((r) => String(r.name)));
  const files = (await readdir(migrationsDir())).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir(), file), "utf8");
    await exec(`BEGIN;\n${sql}\n;INSERT INTO "_migrations" ("name") VALUES ('${file.replace(/'/g, "''")}');\nCOMMIT;`);
    ran.push(file);
  }
  return ran;
}
