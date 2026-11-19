/**
 * Race-condition suite. Runs ONLY against a real Postgres (TEST_DATABASE_URL), where a 25-connection
 * pool lets requests truly overlap — unlike PGlite, which serialises everything. Every burst is
 * wrapped in `t.overlap()`, which samples pg_stat_activity and asserts that several backends were
 * busy at the same moment (proof the race really happened).
 * Run with: npm run test:concurrency
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, setDbOverride, type DB } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, webhookSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import { cancelBooking, createOnlineHold, handlePaymentWebhook } from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import { sendOtp } from "@/lib/otp-service";
import { hitRateLimit } from "@/lib/ratelimit";
import { createTestDb, type TestDb } from "../support/test-db";

const REAL = !!process.env.TEST_DATABASE_URL;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 10);

let t: TestDb;
let db: DB;
let cricketId: string;
let n = 0;

type Err = { code?: string; message?: string; cause?: { code?: string } };
/** "OK", an AppError code (SLOT_TAKEN, RATE_LIMITED…) or "PG:<sqlstate>" for anything unexpected. */
const outcome = (p: Promise<unknown>) => p.then(() => "OK").catch((e: Err) => e.code ?? `PG:${e.cause?.code ?? e.message}`);
const tally = (r: string[]) => r.reduce((m: Record<string, number>, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

describe.skipIf(!REAL)("real-Postgres races (parallel connections)", () => {
  beforeEach(async () => {
    await flushBackground();
    if (t) await t.close();
    t = await createTestDb();
    expect(t.kind).toBe("postgres");
    db = t.db;
    setDbOverride(db);
    await seedDatabase(db, NOW);
    cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
    await db.delete(schema.blockedSlots).where(eq(schema.blockedSlots.courtId, cricketId));
    await db.update(schema.settings).set({ maxActiveBookingsPerPhone: 20, maxBookingsPerPhonePerDay: 50 });
  }, 120_000);

  afterAll(async () => {
    await flushBackground();
    await t?.close();
    setDbOverride(undefined);
  });

  const phoneN = () => `+9196${String(10000000 + ++n).slice(-8)}`;
  const hold = (over: Partial<Parameters<typeof createOnlineHold>[0]> = {}) =>
    createOnlineHold({ courtId: cricketId, date: DATE, times: ["20:00"], name: "Race Test", whatsappOptIn: true, idempotencyKey: `race-${++n}-${Math.random()}`, phone: phoneN(), deviceId: `dev-${n}-${Math.random()}`, ...over });

  it("sanity: the pool runs queries in parallel on several backends", async () => {
    const started = Date.now();
    const rows = await Promise.all(Array.from({ length: 10 }, () => t.rows("select pg_backend_pid() as pid, pg_sleep(0.3)")));
    expect(new Set(rows.map((r) => r[0].pid)).size).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(10 * 300); // ≥ 3 s if serial
  });

  it("50 parallel bookings for one slot → exactly 1 succeeds, 49 'slot taken', fast, no raw DB errors", async () => {
    const started = Date.now();
    const { result: r, maxBusy } = await t.overlap(() => Promise.all(Array.from({ length: 50 }, () => outcome(hold()))));
    expect(tally(r)).toEqual({ OK: 1, SLOT_TAKEN: 49 });
    expect(maxBusy).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(15_000); // was up to 60 s with deadlock cycles (SEC-33)
  });

  it("overlapping ranges in parallel (6–8 vs 7–9, ×10 each) → one booking wins", async () => {
    const { result: r, maxBusy } = await t.overlap(() =>
      Promise.all(Array.from({ length: 20 }, (_, i) => outcome(hold({ times: i % 2 ? ["06:00", "07:00"] : ["07:00", "08:00"] })))),
    );
    expect(tally(r)).toEqual({ OK: 1, SLOT_TAKEN: 19 });
    const active = await db.select().from(schema.bookings).where(and(eq(schema.bookings.courtId, cricketId), eq(schema.bookings.status, "PENDING_PAYMENT")));
    expect(active).toHaveLength(1);
    expect(maxBusy).toBeGreaterThan(1);
  });

  it("20 parallel rate-limiter hits with limit 5 → exactly 5 allowed", async () => {
    const { result: r, maxBusy } = await t.overlap(() => Promise.all(Array.from({ length: 20 }, () => hitRateLimit("race-limit", 5, 60_000))));
    expect(r.filter(Boolean)).toHaveLength(5);
    expect(maxBusy).toBeGreaterThan(1);
  });

  it("10 parallel OTP sends to one number → only 3 codes issued", async () => {
    const { result: r, maxBusy } = await t.overlap(() => Promise.all(Array.from({ length: 10 }, (_, i) => outcome(sendOtp("+919777700011", `10.9.0.${i}`)))));
    expect(tally(r)).toEqual({ OK: 3, RATE_LIMITED: 7 });
    expect(await db.select().from(schema.otpRequests).where(eq(schema.otpRequests.phone, "+919777700011"))).toHaveLength(3);
    expect(maxBusy).toBeGreaterThan(1);
  });

  it("10 parallel bookings by one number with a limit of 2 → exactly 2", async () => {
    await db.update(schema.settings).set({ maxActiveBookingsPerPhone: 2 });
    const phone = "+919777700022";
    const times = ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
    const { result: r, maxBusy } = await t.overlap(() => Promise.all(times.map((tm) => outcome(hold({ phone, times: [tm] })))));
    expect(tally(r)).toEqual({ OK: 2, RATE_LIMITED: 8 });
    expect(maxBusy).toBeGreaterThan(1);
  });

  it("parallel double cancel → one cancellation, one refund", async () => {
    const h = await hold({ times: ["16:00"] });
    const p = getPaymentProvider() as MockPaymentProvider;
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_race_c", order_id: h.order!.orderId, amount: h.order!.amountPaise } } } });
    await handlePaymentWebhook(body, webhookSignature(body, p.webhookSecret), "evt_race_c");
    const d = (await getBookingByCode(h.bookingCode))!;
    const { result: r, maxBusy } = await t.overlap(() =>
      Promise.all(Array.from({ length: 5 }, () => outcome(cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true })))),
    );
    expect(tally(r)).toEqual({ OK: 1, NOT_ALLOWED: 4 });
    const after = (await getBookingByCode(h.bookingCode))!;
    expect(after.payments.reduce((s, x) => s + x.refundAmount, 0)).toBe(300);
    expect(maxBusy).toBeGreaterThan(1);
  });

  it("duplicate webhooks in parallel → one confirmation, one paid Payment, one message", async () => {
    const h = await hold({ times: ["17:00"] });
    const p = getPaymentProvider() as MockPaymentProvider;
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_race_w", order_id: h.order!.orderId, amount: h.order!.amountPaise } } } });
    const sig = webhookSignature(body, p.webhookSecret);
    const { result: r, maxBusy } = await t.overlap(() =>
      Promise.all(Array.from({ length: 8 }, (_, i) => outcome(handlePaymentWebhook(body, sig, i % 2 ? "evt_race_w" : `evt_race_w_${i}`)))),
    );
    expect(tally(r)).toEqual({ OK: 8 });
    await flushBackground();
    const d = (await getBookingByCode(h.bookingCode))!;
    expect(d.booking.status).toBe("CONFIRMED");
    expect(d.payments.filter((x) => x.status === "PAID")).toHaveLength(1);
    const msgs = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "booking_confirmed")));
    expect(msgs).toHaveLength(1);
    expect(maxBusy).toBeGreaterThan(1);
  });
});
