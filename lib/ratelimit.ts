/** Fixed-window rate limiter backed by Postgres, so it works across serverless instances. */
import { and, count, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { AppError } from "@/lib/errors";

export async function hitRateLimit(key: string, limit: number, windowMs: number, now = new Date()): Promise<boolean> {
  const db = await getDb();
  const since = new Date(now.getTime() - windowMs);
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.rateLimitHits)
    .where(and(eq(schema.rateLimitHits.key, key), gt(schema.rateLimitHits.createdAt, since)));
  if (n >= limit) return false;
  await db.insert(schema.rateLimitHits).values({ key, createdAt: now });
  // Opportunistic cleanup of old rows.
  if (Math.random() < 0.02) {
    await db.delete(schema.rateLimitHits).where(lt(schema.rateLimitHits.createdAt, new Date(now.getTime() - 24 * 3_600_000)));
  }
  return true;
}

export async function enforceRateLimit(key: string, limit: number, windowMs: number, message = "Too many requests. Please wait a few minutes and try again.") {
  if (!(await hitRateLimit(key, limit, windowMs))) throw new AppError("RATE_LIMITED", message);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}
