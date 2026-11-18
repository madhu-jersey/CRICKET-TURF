/** Runs once when the server starts. In production (DEMO_MODE=false) it refuses to run with demo settings. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("@/lib/startup-checks");
  await runStartupChecks();
}
