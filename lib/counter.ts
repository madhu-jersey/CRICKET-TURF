/**
 * Shared fixed-window counters (one row/key per window, not a row per request).
 * Backends: Postgres "Counter" table (default) or Upstash Redis when UPSTASH_REDIS_REST_URL is set.
 * Both increment atomically, so every server instance shares the same count. [SEC-37]
 */
import "server-only";
import { eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";

export interface CounterStore {
  /** Atomically adds `by` (default 1) to `key` and returns the new value. The key expires at `expiresAt`. */
  incr(key: string, expiresAt: Date, by?: number): Promise<number>;
  get(key: string): Promise<number>;
}

export class PgCounterStore implements CounterStore {
  async incr(key: string, expiresAt: Date, by = 1) {
    const db = await getDb();
    const [row] = await db
      .insert(schema.counters)
      .values({ key, count: by, expiresAt })
      .onConflictDoUpdate({ target: schema.counters.key, set: { count: sql`${schema.counters.count} + ${by}` } })
      .returning({ count: schema.counters.count });
    if (Math.random() < 0.01) await db.delete(schema.counters).where(lt(schema.counters.expiresAt, new Date()));
    return row.count;
  }
  async get(key: string) {
    const db = await getDb();
    const [row] = await db.select({ count: schema.counters.count, expiresAt: schema.counters.expiresAt }).from(schema.counters).where(eq(schema.counters.key, key));
    return row && row.expiresAt > new Date() ? row.count : 0;
  }
}

export class UpstashCounterStore implements CounterStore {
  constructor(private url: string, private token: string) {}
  private async pipeline(cmds: (string | number)[][]) {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Upstash error ${res.status}`);
    return (await res.json()) as { result: unknown }[];
  }
  async incr(key: string, expiresAt: Date, by = 1) {
    const r = await this.pipeline([["INCRBY", key, by], ["PEXPIREAT", key, expiresAt.getTime()]]);
    return Number(r[0].result);
  }
  async get(key: string) {
    const r = await this.pipeline([["GET", key]]);
    return Number(r[0].result ?? 0);
  }
}

let store: CounterStore | undefined;
export function getCounterStore(): CounterStore {
  if (!store) {
    const url = env.str("UPSTASH_REDIS_REST_URL");
    store = url ? new UpstashCounterStore(url, env.str("UPSTASH_REDIS_REST_TOKEN")) : new PgCounterStore();
  }
  return store;
}

/** Fixed-window limiter: returns true while the window's count is ≤ limit. */
export async function windowLimit(key: string, limit: number, windowMs: number, now = new Date(), s: CounterStore = getCounterStore()) {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const count = await s.incr(`${key}:${start}`, new Date(start + windowMs));
  return count <= limit;
}

// ── Cache versions (bumped when data behind a cache key changes) ──

export async function getVersion(key: string): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ v: schema.cacheVersions.version }).from(schema.cacheVersions).where(eq(schema.cacheVersions.key, key));
  return row?.v ?? 0;
}

export async function bumpVersion(key: string) {
  const db = await getDb();
  await db
    .insert(schema.cacheVersions)
    .values({ key, version: 1 })
    .onConflictDoUpdate({ target: schema.cacheVersions.key, set: { version: sql`${schema.cacheVersions.version} + 1`, updatedAt: new Date() } });
}
