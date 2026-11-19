/**
 * P3 hardening: SEC-57 no-show count resets on unblock · SEC-58 limiter cleanup in the cron ·
 * SEC-59 auto-complete · SEC-60 availability cache invalidated by config edits.
 * (SEC-61 price notice and SEC-60's route wiring are tested over HTTP in http.spec.ts; SEC-62 in
 * tests/unit/raw-sql.test.ts; SEC-63 in tests/e2e/admin-panels.spec.ts.)
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { setDbOverride, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey, istToUtc } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { autoCompleteBookings, setBookingOutcome } from "@/lib/booking/service";
import { listCourts } from "@/lib/booking/data";
import { cleanupLimiterTables } from "@/lib/ratelimit";
import { clearAvailabilityCache, getCachedAvailability, invalidateAllAvailability, invalidateCourtConfig } from "@/lib/booking/availability-cache";

let t: TestDb;
let db: DB;
let courtId: string;
let cricketId: string;
const NOW = new Date();

beforeEach(async () => {
  await flushBackground();
  if (t) await t.close();
  t = await createTestDb();
  db = t.db;
  setDbOverride(db);
  await seedDatabase(db, NOW);
  const courts = await listCourts(db);
  courtId = courts.find((c) => c.name === "Pickleball Court 2")!.id;
  cricketId = courts.find((c) => c.sport === "CRICKET")!.id;
  await db.update(schema.bookings).set({ status: "CANCELLED" }).where(eq(schema.bookings.courtId, courtId)); // a clear court
  clearAvailabilityCache();
});
afterAll(async () => {
  await flushBackground();
  await t?.close();
  setDbOverride(undefined);
});

let seq = 0;
async function customer() {
  const [c] = await db.insert(schema.customers).values({ name: "No Show", phone: `+9198765${String(57000 + ++seq)}` }).returning();
  return c;
}
async function booking(customerId: string, startAt: Date, status: "CONFIRMED" | "PENDING_PAYMENT" = "CONFIRMED") {
  const [b] = await db
    .insert(schema.bookings)
    .values({ bookingCode: `BBA-P3T${String(++seq).padStart(4, "0")}`, customerId, courtId, startAt, endAt: new Date(startAt.getTime() + 3_600_000), status, totalAmount: 600, advanceAmount: 300, balanceAmount: 300, source: "ONLINE" })
    .returning();
  return b;
}
const H = 3_600_000;

describe("SEC-57 unblocking restarts the no-show count", () => {
  it("3 no-shows block; after the owner unblocks, the next no-show doesn't re-block", async () => {
    const base = new Date(NOW.getTime() + 30 * 24 * H); // clear of demo bookings
    const c = await customer();
    for (let i = 0; i < 3; i++) {
      const b = await booking(c.id, new Date(base.getTime() + i * H));
      await setBookingOutcome(b.id, "NO_SHOW", "staff@demo.com", new Date(base.getTime() + 10 * H));
    }
    let [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id));
    expect(row.isBlocked).toBe(true);

    // What PATCH /api/admin/customers does on unblock.
    const unblockedAt = new Date(base.getTime() + 11 * H);
    await db.update(schema.customers).set({ isBlocked: false, blockedAt: null, blockedReason: null, noShowResetAt: unblockedAt }).where(eq(schema.customers.id, c.id));

    const next = await booking(c.id, new Date(base.getTime() + 12 * H));
    await setBookingOutcome(next.id, "NO_SHOW", "staff@demo.com", new Date(base.getTime() + 20 * H));
    [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id));
    expect(row.isBlocked).toBe(false); // 1 no-show since the reset, not 4
  });
});

describe("SEC-58 limiter tables are cleaned by the cron, in batches", () => {
  it("removes RateLimitHit rows older than 48 h and expired counters; keeps recent ones; respects the batch size", async () => {
    const old = new Date(NOW.getTime() - 49 * H);
    await db.insert(schema.rateLimitHits).values([...Array.from({ length: 5 }, () => ({ key: "k-old", createdAt: old })), ...Array.from({ length: 3 }, () => ({ key: "k-new", createdAt: NOW }))]);
    await db.insert(schema.counters).values([
      { key: "c-old-1", count: 1, expiresAt: new Date(NOW.getTime() - H) },
      { key: "c-old-2", count: 1, expiresAt: new Date(NOW.getTime() - H) },
      { key: "c-live", count: 1, expiresAt: new Date(NOW.getTime() + H) },
    ]);
    expect(await cleanupLimiterTables(NOW, 2)).toEqual({ rateLimitHits: 2, counters: 2 });
    expect(await cleanupLimiterTables(NOW)).toEqual({ rateLimitHits: 3, counters: 0 });
    const hits = await db.select().from(schema.rateLimitHits).where(like(schema.rateLimitHits.key, "k-%"));
    expect(hits.map((h) => h.key)).toEqual(["k-new", "k-new", "k-new"]);
    expect((await db.select().from(schema.counters).where(like(schema.counters.key, "c-%"))).map((c) => c.key)).toEqual(["c-live"]);
  });
});

describe("SEC-59 confirmed bookings auto-complete after autoCompleteHours", () => {
  it("default 6 h: ended 7 h ago → COMPLETED, ended 5 h ago → still CONFIRMED; never NO_SHOW; 0 turns it off", async () => {
    const c = await customer();
    const done = await booking(c.id, new Date(NOW.getTime() - 8 * H)); // ended 7 h ago
    const recent = await booking(c.id, new Date(NOW.getTime() - 6 * H)); // ended 5 h ago
    const pending = await booking(c.id, new Date(NOW.getTime() - 10 * H), "PENDING_PAYMENT");
    expect(await autoCompleteBookings(NOW)).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => (await db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0].status;
    expect(await status(done.id)).toBe("COMPLETED");
    expect(await status(recent.id)).toBe("CONFIRMED");
    expect(await status(pending.id)).toBe("PENDING_PAYMENT");
    expect(await db.select().from(schema.bookings).where(eq(schema.bookings.status, "NO_SHOW")).then((r) => r.filter((b) => b.customerId === c.id))).toHaveLength(0);
    // Staff can still change it to a no-show.
    await setBookingOutcome(done.id, "NO_SHOW", "staff@demo.com", NOW);
    expect(await status(done.id)).toBe("NO_SHOW");

    await db.update(schema.settings).set({ autoCompleteHours: 0 });
    expect(await autoCompleteBookings(new Date(NOW.getTime() + 48 * H))).toBe(0);
    expect(await status(recent.id)).toBe("CONFIRMED");
  });
});

describe("SEC-60 config edits invalidate the availability cache at once", () => {
  async function weekdayKey() {
    for (let d = 1; d < 14; d++) {
      const key = addDays(istDateKey(NOW), d);
      const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
      const holidays = await db.select().from(schema.holidays).where(eq(schema.holidays.date, key));
      if (dow >= 1 && dow <= 5 && !holidays.length) return key;
    }
    throw new Error("no weekday");
  }
  const priceAt = async (court: string, key: string, time: string) => (await getCachedAvailability(court, key, new Date())).slots.find((s) => s.time === time)!.price;

  it("a price edit is visible on the next call after invalidateCourtConfig; without it the cache would still serve the old price", async () => {
    const key = await weekdayKey();
    const before = await priceAt(cricketId, key, "07:00");
    await db.update(schema.pricingRules).set({ pricePerSlot: before + 111 }).where(and(eq(schema.pricingRules.courtId, cricketId), eq(schema.pricingRules.dayType, "WEEKDAY"), eq(schema.pricingRules.startTime, "06:00")));
    expect(await priceAt(cricketId, key, "07:00")).toBe(before); // cached
    await invalidateCourtConfig([cricketId]);
    expect(await priceAt(cricketId, key, "07:00")).toBe(before + 111);
  });

  it("a new holiday is visible on the next call after invalidateAllAvailability", async () => {
    const key = await weekdayKey();
    const weekday = await priceAt(cricketId, key, "07:00");
    await db.insert(schema.holidays).values({ date: key, name: "Test holiday" });
    expect(await priceAt(cricketId, key, "07:00")).toBe(weekday); // cached
    await invalidateAllAvailability();
    expect(await priceAt(cricketId, key, "07:00")).not.toBe(weekday); // holiday rate
    expect(istToUtc(key, "07:00").getTime()).toBeGreaterThan(NOW.getTime());
  });
});
