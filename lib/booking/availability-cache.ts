/**
 * Short cache for the public availability grid (polled every 30 s by every open booking page).
 * Entries live 12 s and are keyed by court + IST day. A shared version number per court/day is
 * bumped on every booking, cancellation, block or hold expiry, so a change is visible on the next
 * poll on every server instance — the TTL only covers changes we don't track (prices, hours).
 * Bookings themselves never use the cache: holds re-check live data inside the transaction. [SEC-37]
 */
import "server-only";
import { getDb } from "@/db/client";
import { bumpVersion, getVersion } from "@/lib/counter";
import { loadAvailability, type Availability } from "@/lib/booking/data";
import { istDateKey } from "@/lib/time";

export const AVAILABILITY_TTL_MS = 12_000;
const cache = new Map<string, { version: number; expires: number; data: Availability }>();
let computeCount = 0;

const keyFor = (courtId: string, dateKey: string) => `avail:${courtId}:${dateKey}`;

export async function getCachedAvailability(courtId: string, dateKey: string, now = new Date()): Promise<Availability> {
  const key = keyFor(courtId, dateKey);
  const version = await getVersion(key);
  const hit = cache.get(key);
  if (hit && hit.version === version && hit.expires > now.getTime()) return hit.data;
  computeCount++;
  const data = await loadAvailability(await getDb(), courtId, dateKey, now);
  cache.set(key, { version, expires: now.getTime() + AVAILABILITY_TTL_MS, data });
  if (cache.size > 2000) for (const [k, v] of cache) if (v.expires <= now.getTime()) cache.delete(k);
  return data;
}

/** Call after anything that changes which slots are free on a court/day. Never throws. */
export async function invalidateAvailability(courtId: string, startAt: Date) {
  try {
    await bumpVersion(keyFor(courtId, istDateKey(startAt)));
  } catch (e) {
    console.warn("[availability-cache] invalidate failed", e);
  }
}

/** Test helpers. */
export function availabilityComputeCount() {
  return computeCount;
}
export function clearAvailabilityCache() {
  cache.clear();
}
