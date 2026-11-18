// npm run test:concurrency        → race suite only
// npm run test:realdb             → every Vitest suite (unit, integration, security, races) on real Postgres
// Runs the race-condition suite against a REAL Postgres (many connections, truly parallel).
// - If TEST_DATABASE_URL is set (Docker, CI service container, Supabase staging), it is used.
// - Otherwise a throwaway Postgres 17 is started with the `embedded-postgres` package and removed afterwards.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(env) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolve) => {
    const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["tests/concurrency"];
    const p = spawn(npx, ["vitest", "run", ...targets], { env, stdio: "inherit", shell: process.platform === "win32" });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

let code;
if (process.env.TEST_DATABASE_URL) {
  code = await run({ ...process.env });
} else {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = mkdtempSync(path.join(tmpdir(), "bba-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, port, user: "postgres", password: "postgres", persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {} });
  console.log(`[concurrency] starting embedded Postgres 17 on port ${port}…`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("bba_test");
  try {
    code = await run({ ...process.env, TEST_DATABASE_URL: `postgres://postgres:postgres@localhost:${port}/bba_test` });
  } finally {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(code);
