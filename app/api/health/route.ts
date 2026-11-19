import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

/** How long the database may take to answer before the site is reported unhealthy. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

/**
 * Uptime check for UptimeRobot or similar. No auth and no data: just "ok" (200) when the database
 * answers `select 1` within 2 s, otherwise "unavailable" (503). [SEC-55]
 */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => (await getDb()).execute(sql`select 1`))(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database timeout")), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  } catch {
    return new Response("unavailable", { status: 503, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "Retry-After": "30" } });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
