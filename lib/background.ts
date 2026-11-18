/**
 * Runs work after the response is sent. Inside a Next.js request this uses `after()` so Vercel
 * keeps the function alive; elsewhere (tests, scripts) it just starts the promise.
 */
const pending = new Set<Promise<unknown>>();

export function runInBackground(fn: () => Promise<unknown>) {
  const start = () => {
    const p = fn().catch((e) => console.error("[background] task failed", e));
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { after } = require("next/server") as typeof import("next/server");
    after(start);
  } catch {
    void start();
  }
}

/** Test helper: wait for all background work started so far. */
export async function flushBackground() {
  while (pending.size) await Promise.all([...pending]);
}
