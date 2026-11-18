// Builds and starts an isolated production server for Playwright: fresh embedded DB,
// separate build folder, port 3100. Usage: node scripts/e2e-server.mjs
import { rmSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

const env = {
  ...process.env,
  PGLITE_DIR: "./node_modules/.cache/bba-pglite-e2e",
  NEXT_DIST_DIR: ".next-e2e",
  DEMO_MODE: "true",
  PAYMENT_PROVIDER: "mock",
  MESSAGING_PROVIDER: "mock",
  OTP_PROVIDER: "mock",
  APP_SECRET: "e2e-secret-not-for-production-0123456789abcdef",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  // Exercise the real two-factor admin login in the browser tests (demo shows the code).
  ADMIN_2FA_REQUIRED: "true",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3100",
  MESSAGE_RETRY_BASE_MS: "50",
};
rmSync(env.PGLITE_DIR, { recursive: true, force: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (!process.env.E2E_SKIP_BUILD) {
  const b = spawnSync(npx, ["next", "build"], { env, stdio: "inherit", shell: process.platform === "win32" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const s = spawn(npx, ["next", "start", "-p", "3100"], { env, stdio: "inherit", shell: process.platform === "win32" });
const stop = () => s.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
s.on("exit", (code) => process.exit(code ?? 0));
