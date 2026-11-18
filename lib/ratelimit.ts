/** Sliding-window rate limiter backed by Postgres, so it works across serverless instances. */
import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { AppError } from "@/lib/errors";

/**
 * Check-and-record in one transaction under a per-key advisory lock, so parallel requests for the
 * same key queue up: exactly `limit` hits per window get through, never more (the old
 * count-then-insert let bursts slip past). [SEC-07]
 */
export async function hitRateLimit(key: string, limit: number, windowMs: number, now = new Date()): Promise<boolean> {
  const db = await getDb();
  const allowed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"rl:" + key}))`);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(schema.rateLimitHits)
      .where(and(eq(schema.rateLimitHits.key, key), gt(schema.rateLimitHits.createdAt, new Date(now.getTime() - windowMs))));
    if (n >= limit) return false;
    await tx.insert(schema.rateLimitHits).values({ key, createdAt: now });
    return true;
  });
  if (Math.random() < 0.02) {
    await db.delete(schema.rateLimitHits).where(lt(schema.rateLimitHits.createdAt, new Date(now.getTime() - 48 * 3_600_000)));
  }
  return allowed;
}

export async function enforceRateLimit(key: string, limit: number, windowMs: number, message = "Too many requests. Please wait a few minutes and try again.") {
  if (!(await hitRateLimit(key, limit, windowMs))) throw new AppError("RATE_LIMITED", message);
}

/**
 * Client IP for rate limiting. Never trust the left-most X-Forwarded-For entry: the client can
 * write anything there. Use the platform header (Vercel sets x-real-ip / x-vercel-forwarded-for
 * and overwrites client values), otherwise the right-most XFF entry, which is the one appended by
 * our own reverse proxy. [SEC-06]
 */
export function clientIp(req: Request): string {
  return ipFromHeaders(req.headers);
}

export function ipFromHeaders(h: Headers): string {
  const platform = h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip");
  if (platform) return platform.split(",")[0].trim().slice(0, 64);
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return "unknown";
}

/** Cheap per-instance limiter for high-frequency, read-only endpoints (no DB write per request). */
const buckets = new Map<string, { n: number; reset: number }>();
export function memoryRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    return true;
  }
  b.n++;
  return b.n <= limit;
}
