/** Runs once when the server starts. In production (DEMO_MODE=false) it refuses to run with demo settings. */
/** Errors from pages / server components (route handlers report through lib/errors.ts). [SEC-55] */
export async function onRequestError(err: unknown, request: { path: string; method: string }) {
  const { reportError } = await import("@/lib/error-report");
  reportError(err, { method: request.method, path: request.path });
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("@/lib/startup-checks");
  await runStartupChecks();
}
