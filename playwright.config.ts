import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/**/*.spec.ts", "security/**/*.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one embedded DB, and tests book real slots
  retries: 0,
  // In CI, also report failures as GitHub annotations (readable without signing in to view logs).
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:3100",
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
