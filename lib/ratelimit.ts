/** Sliding-window rate limiter backed by Postgres, so it works across serverless instances. */
import { and, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
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
  return allowed;
}

/** Rows older than this are never needed (the longest window is 24 h). */
export const LIMITER_RETENTION_MS = 48 * 3_600_000;

/**
 * Cron cleanup (replaces the old random 2 % / 1 % cleanups, which ran inside user requests and used
 * the real clock): deletes RateLimitHit rows older than 48 h and expired Counter rows, at most
 * `batch` of each per run so one run can't lock the tables for long. [SEC-58]
 */
export async function cleanupLimiterTables(now = new Date(), batch = 10_000) {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - LIMITER_RETENTION_MS);
  const hits = await db
    .delete(schema.rateLimitHits)
    .where(inArray(schema.rateLimitHits.id, db.select({ id: schema.rateLimitHits.id }).from(schema.rateLimitHits).where(lt(schema.rateLimitHits.createdAt, cutoff)).limit(batch)))
    .returning({ id: schema.rateLimitHits.id });
  const counters = await db
    .delete(schema.counters)
    .where(inArray(schema.counters.key, db.select({ key: schema.counters.key }).from(schema.counters).where(lt(schema.counters.expiresAt, now)).limit(batch)))
    .returning({ key: schema.counters.key });
  return { rateLimitHits: hits.length, counters: counters.length };
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
