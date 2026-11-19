/**
 * SEC-52: `npm run deploy:migrate` holds a session advisory lock, so two runs at once (e.g. a retried
 * CI job) can't apply migrations concurrently. Real Postgres only: creates a throwaway database,
 * runs two deploy processes in parallel, checks every migration was applied exactly once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import postgres from "postgres";
import { MIGRATIONS } from "@/db/migration-list";

const URL_ = process.env.TEST_DATABASE_URL;
const dbName = `bba_migrate_${Date.now().toString(36)}`;

function deploy(url: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const p = spawn(npx, ["tsx", "db/cli.ts", "deploy"], { env: { ...process.env, DATABASE_URL: url }, shell: process.platform === "win32" });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

describe.skipIf(!URL_)("deploy:migrate on real Postgres", () => {
  const admin = URL_ ? postgres(URL_, { max: 1, onnotice: () => {} }) : null;
  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin.end();
  });

  it("two parallel runs: both succeed, every migration applied exactly once", async () => {
    await admin!.unsafe(`create database "${dbName}"`);
    const u = new URL(URL_!);
    u.pathname = `/${dbName}`;
    const [a, b] = await Promise.all([deploy(u.toString()), deploy(u.toString())]);
    expect(a.code, a.out).toBe(0);
    expect(b.code, b.out).toBe(0);
    const outs = [a.out, b.out].join("\n");
    expect(outs).toMatch(/Applied migrations: 0001_init\.sql/);
    expect(outs).toMatch(/Migrations already up to date/);
    const c = postgres(u.toString(), { max: 1 });
    const rows = await c`select "name" from "_migrations" order by "name"`;
    await c.end();
    expect(rows.map((r) => r.name)).toEqual([...MIGRATIONS]);
  }, 120_000);
});
