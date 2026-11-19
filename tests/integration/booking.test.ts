/**
 * Integration tests against a real Postgres (PGlite in memory) with the real schema, exclusion
 * constraint and seed data. Uses PGlite by default, or a real Postgres when TEST_DATABASE_URL is set.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setDbOverride, pgErrorCode, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey, istToUtc } from "@/lib/time";
import { AppError } from "@/lib/errors";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, webhookSignature, checkoutSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import {
  cancelBooking,
  confirmPayment,
  createAdminBooking,
  createOnlineHold,
  expireHolds,
  handlePaymentWebhook,
  sendReminders,
} from "@/lib/booking/service";
import { getBookingByCode, listCourts, loadAvailability } from "@/lib/booking/data";
import { sendOtp, verifyOtp } from "@/lib/otp-service";

let db: DB;
let close: () => Promise<void>;
let testDb: TestDb;
let cricketId: string;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 10);

beforeEach(async () => {
  await flushBackground();
  if (close) await close();
  testDb = await createTestDb(); // PGlite, or real Postgres when TEST_DATABASE_URL is set
  ({ db, close } = testDb);
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
  // Make sure the test slots are free (seed bookings only go up to +7 days, but be explicit).
  await db.delete(schema.blockedSlots).where(eq(schema.blockedSlots.courtId, cricketId));
});

afterAll(async () => {
  await flushBackground();
  await close?.();
  setDbOverride(undefined);
});

const mock = () => getPaymentProvider() as MockPaymentProvider;
let n = 0;
const hold = (over: Partial<Parameters<typeof createOnlineHold>[0]> = {}, now = NOW) =>
  createOnlineHold(
    {
      courtId: cricketId,
      date: DATE,
      times: ["20:00"],
      name: "Test Player",
      whatsappOptIn: true,
      idempotencyKey: `idem-${++n}-${Math.random()}`,
      phone: `+9198${String(10000000 + n).slice(-8)}`,
      deviceId: `test-device-${n}-${Math.random().toString(36).slice(2)}`,
      ...over,
    },
    now,
  );

function webhookBody(orderId: string, paymentId: string, amountPaise: number, event = "payment.captured") {
  return JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, status: "captured" } } } });
}
async function deliverWebhook(body: string, eventId: string) {
  return handlePaymentWebhook(body, webhookSignature(body, mock().webhookSecret), eventId);
}

describe("double booking protection", () => {
  it("10 parallel requests for the same slot → exactly 1 succeeds", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => hold()));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const f of failed) expect((f.reason as AppError).code).toBe("SLOT_TAKEN");
    const active = await db.select().from(schema.bookings).where(and(eq(schema.bookings.courtId, cricketId), eq(schema.bookings.status, "PENDING_PAYMENT")));
    expect(active).toHaveLength(1);
  });

  it("the database itself rejects overlapping active bookings (exclusion constraint)", async () => {
    const h = await hold({ times: ["18:00", "19:00"] });
    const b = (await getBookingByCode(h.bookingCode))!.booking;
    const err = await db
      .insert(schema.bookings)
      .values({ ...b, id: crypto.randomUUID(), bookingCode: "BBA-RAW001", idempotencyKey: null, startAt: istToUtc(DATE, "19:00"), endAt: istToUtc(DATE, "21:00"), status: "CONFIRMED" })
      .then(() => null)
      .catch((e) => e);
    expect(pgErrorCode(err)).toBe("23P01");
    // Touching ranges ('[)') are fine.
    await db.insert(schema.bookings).values({ ...b, id: crypto.randomUUID(), bookingCode: "BBA-RAW002", idempotencyKey: null, startAt: istToUtc(DATE, "20:00"), endAt: istToUtc(DATE, "21:00"), status: "CONFIRMED" });
  });

  it("same idempotency key twice → one booking", async () => {
    const a = await hold({ idempotencyKey: "same-key-123", phone: "+919811111111" });
    const b = await hold({ idempotencyKey: "same-key-123", phone: "+919811111111" });
    expect(b.bookingCode).toBe(a.bookingCode);
    expect(b.order?.orderId).toBe(a.order?.orderId);
  });

  it("walk-in overlapping an online booking is rejected", async () => {
    await hold({ times: ["21:00"] });
    await expect(
      createAdminBooking(
        { courtId: cricketId, date: DATE, times: ["21:00"], name: "Walk In", phone: "+919822222222", whatsappOptIn: false, source: "WALK_IN", amountReceived: 0, paymentMode: "CASH" },
        "owner@demo.com",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
  });

  it("server ignores client prices: total comes from pricing rules", async () => {
    const h = await hold({ times: ["17:00", "18:00"] });
    const dow = new Date(istToUtc(DATE, "12:00")).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const subtotal = weekend ? 1000 + 1400 : 800 + 1200;
    expect(h.subtotal).toBe(subtotal);
    // A brand-new number gets the 10% first-booking offer.
    expect(h.discount).toBe(subtotal / 10);
    expect(h.total).toBe(subtotal - subtotal / 10);
    expect(h.advance).toBe(300);
    expect(h.balance).toBe(h.total - 300);
  });
});

describe("payments", () => {
  it("webhook delivered twice → confirmed once, one Payment row, one WhatsApp message", async () => {
    const h = await hold();
    const body = webhookBody(h.order!.orderId, "pay_test_1", h.order!.amountPaise);
    const r1 = await deliverWebhook(body, "evt_1");
    const r2 = await deliverWebhook(body, "evt_1");
    const r3 = await deliverWebhook(body, "evt_1_redelivered_with_new_id");
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect((r3.result as { outcome: string }).outcome).toBe("ALREADY_PROCESSED");
    // The checkout callback arriving after the webhook is also a no-op.
    const again = await confirmPayment({ orderId: h.order!.orderId, paymentId: "pay_test_1", via: "checkout" });
    expect(again.outcome).toBe("ALREADY_PROCESSED");
    await flushBackground();

    const d = (await getBookingByCode(h.bookingCode))!;
    expect(d.booking.status).toBe("CONFIRMED");
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0].status).toBe("PAID");
    const msgs = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "booking_confirmed")));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe("MOCKED");
    const ownerAlerts = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "admin_new_booking")));
    expect(ownerAlerts).toHaveLength(1);
  });

  it("rejects webhooks with a bad signature", async () => {
    const h = await hold();
    const body = webhookBody(h.order!.orderId, "pay_x", h.order!.amountPaise);
    await expect(handlePaymentWebhook(body, "deadbeef", "evt_bad")).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await expect(handlePaymentWebhook(body.replace("captured", "capturedX"), webhookSignature(body, mock().webhookSecret), "evt_bad2")).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("PENDING_PAYMENT");
  });

  it("does not confirm when the paid amount doesn't match", async () => {
    const h = await hold();
    const r = await deliverWebhook(webhookBody(h.order!.orderId, "pay_y", 100), "evt_amt");
    expect((r.result as { outcome: string }).outcome).toBe("AMOUNT_MISMATCH");
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("PENDING_PAYMENT");
  });

  it("checkout signature generated by the provider verifies", () => {
    const sig = checkoutSignature("order_1", "pay_1", mock().keySecret);
    expect(mock().verifyCheckoutSignature({ orderId: "order_1", paymentId: "pay_1", signature: sig })).toBe(true);
  });
});

describe("new customer offer", () => {
  const phone = "+919855555555";
  it("applies once per mobile number, and not to returning customers", async () => {
    // This test needs 3 bookings from one number; the per-number limit has its own security test.
    await db.update(schema.settings).set({ maxActiveBookingsPerPhone: 5 });
    const first = await hold({ phone, times: ["14:00"] });
    expect(first.discount).toBeGreaterThan(0);
    // A second hold while the first (discounted) one is still open does not get it again.
    const second = await hold({ phone, times: ["15:00"] });
    expect(second.discount).toBe(0);
    // After paying the first booking, the number is a returning customer.
    await deliverWebhook(webhookBody(first.order!.orderId, "pay_offer", first.order!.amountPaise), "evt_offer");
    const third = await hold({ phone, times: ["16:00"] });
    expect(third.discount).toBe(0);
  });

  it("1 phone, 1 offer: a new number on a device that already used the offer gets no discount", async () => {
    const device = "shared-phone-device-0001";
    const first = await hold({ phone: "+919811100001", deviceId: device, times: ["09:00"] });
    expect(first.discount).toBeGreaterThan(0);
    const otherNumberSameDevice = await hold({ phone: "+919811100002", deviceId: device, times: ["10:00"] });
    expect(otherNumberSameDevice.discount).toBe(0);
    const newNumberNewDevice = await hold({ phone: "+919811100003", deviceId: "another-device-0002xx", times: ["11:00"] });
    expect(newNumberNewDevice.discount).toBeGreaterThan(0);
    // No device ID (cookie missing) → no offer.
    expect((await hold({ phone: "+919811100004", deviceId: null, times: ["12:00"] })).discount).toBe(0);
  });

  it("parallel holds from one device with different new numbers → only one discount", async () => {
    const device = "race-device-000000001";
    const rs = await Promise.all([1, 2, 3].map((k) => hold({ phone: `+91982220000${k}`, deviceId: device, times: [`${12 + k}:00`] })));
    expect(rs.filter((r) => r.discount > 0)).toHaveLength(1);
  });

  it("is given back if the discounted hold expires unpaid", async () => {
    const p = "+919866666666";
    const a = await hold({ phone: p, times: ["17:00"] });
    expect(a.discount).toBeGreaterThan(0);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const b = await hold({ phone: p, times: ["18:00"] }, later);
    expect(b.discount).toBeGreaterThan(0);
  });

  it("seeded customers with past bookings don't get it; the owner can switch it off", async () => {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.phone, "+919848012345"));
    const past = await db.select().from(schema.bookings).where(and(eq(schema.bookings.customerId, c.id), eq(schema.bookings.status, "COMPLETED")));
    if (past.length) expect((await hold({ phone: c.phone, times: ["19:00"] })).discount).toBe(0);
    await db.update(schema.settings).set({ newCustomerDiscountPercent: 0 });
    expect((await hold({ phone: "+919877777777", times: ["20:00"] })).discount).toBe(0);
  });
});

describe("holds", () => {
  it("expired hold frees the slot (even before the cron runs)", async () => {
    const h = await hold({ times: ["22:00"] });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const avail = await loadAvailability(db, cricketId, DATE, later);
    expect(avail.slots.find((s) => s.time === "22:00")!.state).toBe("AVAILABLE");
    const second = await hold({ times: ["22:00"] }, later); // stale hold is flipped inside the tx
    expect(second.status).toBe("PENDING_PAYMENT");
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("EXPIRED");
  });

  it("cron moves expired holds to EXPIRED", async () => {
    const h = await hold({ times: ["06:00"] });
    expect(await expireHolds(NOW)).toBe(0);
    expect(await expireHolds(new Date(NOW.getTime() + 11 * 60_000))).toBeGreaterThanOrEqual(1);
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("EXPIRED");
  });

  it("payment after hold expiry, slot still free → confirmed late", async () => {
    const h = await hold({ times: ["07:00"] });
    await expireHolds(new Date(NOW.getTime() + 11 * 60_000));
    const r = await deliverWebhook(webhookBody(h.order!.orderId, "pay_late", h.order!.amountPaise), "evt_late");
    expect((r.result as { outcome: string }).outcome).toBe("CONFIRMED_LATE");
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("CONFIRMED");
  });

  it("payment after hold expiry, slot taken → auto-refund", async () => {
    const a = await hold({ times: ["08:00"] });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const b = await hold({ times: ["08:00"] }, later);
    const r = await deliverWebhook(webhookBody(a.order!.orderId, "pay_lost", a.order!.amountPaise), "evt_lost");
    expect((r.result as { outcome: string }).outcome).toBe("REFUND_SLOT_TAKEN");
    await flushBackground();
    const da = (await getBookingByCode(a.bookingCode))!;
    expect(da.booking.status).toBe("REFUNDED");
    expect(da.payments[0].status).toBe("REFUNDED");
    expect(da.payments[0].refundAmount).toBe(300);
    expect((await getBookingByCode(b.bookingCode))!.booking.status).toBe("PENDING_PAYMENT");
    const cancelMsg = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, da.booking.id), eq(schema.messageLogs.template, "booking_cancelled")));
    expect(cancelMsg).toHaveLength(1);
  });
});

describe("cancellation", () => {
  async function confirmedBooking(times = ["09:00"]) {
    const h = await hold({ times });
    await deliverWebhook(webhookBody(h.order!.orderId, `pay_${h.bookingCode}`, h.order!.amountPaise), `evt_${h.bookingCode}`);
    return (await getBookingByCode(h.bookingCode))!;
  }

  it("customer cancel before cutoff → full advance refund", async () => {
    const d = await confirmedBooking();
    const r = await cancelBooking({ bookingId: d.booking.id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true }, NOW);
    expect(r).toMatchObject({ status: "REFUNDED", refunded: 300 });
    const after = (await getBookingByCode(d.booking.bookingCode))!;
    expect(after.booking.status).toBe("REFUNDED");
    expect(after.payments[0].refundAmount).toBe(300);
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "payment.refund"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("customer cancel 2.5 hours before → still a full refund (2 hour policy)", async () => {
    const d = await confirmedBooking(["15:00"]);
    const at = new Date(d.booking.startAt.getTime() - 150 * 60_000);
    const r = await cancelBooking({ bookingId: d.booking.id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true }, at);
    expect(r).toMatchObject({ status: "REFUNDED", refunded: 300 });
  });

  it("customer cancel inside the cutoff → no refund", async () => {
    const d = await confirmedBooking(["10:00"]);
    const closeToStart = new Date(d.booking.startAt.getTime() - 90 * 60_000); // 1.5 h before: inside the 2 h cutoff
    const r = await cancelBooking({ bookingId: d.booking.id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true }, closeToStart);
    expect(r).toMatchObject({ status: "CANCELLED", refunded: 0 });
  });

  it("admin partial refund", async () => {
    const d = await confirmedBooking(["11:00"]);
    const r = await cancelBooking({ bookingId: d.booking.id, actor: "owner@demo.com", by: "ADMIN", refund: { mode: "PARTIAL", amount: 100 } }, NOW);
    expect(r).toMatchObject({ status: "REFUNDED", refunded: 100 });
    const p = (await getBookingByCode(d.booking.bookingCode))!.payments[0];
    expect(p.refundAmount).toBe(100);
    expect(p.status).toBe("PAID"); // partially refunded
  });

  it("cancelled slot becomes bookable again", async () => {
    const d = await confirmedBooking(["12:00"]);
    await cancelBooking({ bookingId: d.booking.id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true }, NOW);
    await expect(hold({ times: ["12:00"] })).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
  });
});

describe("OTP service", () => {
  it("sends, verifies once, and rate-limits per phone", async () => {
    const phone = "+919833333333";
    const { devCode } = await sendOtp(phone, "1.1.1.1");
    expect(devCode).toMatch(/^\d{6}$/);
    await expect(verifyOtp(phone, devCode === "000000" ? "111111" : "000000")).rejects.toMatchObject({ code: "OTP_INVALID" });
    await verifyOtp(phone, devCode!);
    await expect(verifyOtp(phone, devCode!)).rejects.toMatchObject({ code: "OTP_INVALID" }); // single use
    await sendOtp(phone, "1.1.1.1");
    await sendOtp(phone, "1.1.1.1");
    await expect(sendOtp(phone, "1.1.1.1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("locks a code after 5 wrong attempts", async () => {
    const phone = "+919844444444";
    const { devCode } = await sendOtp(phone, "2.2.2.2");
    const wrong = devCode === "123456" ? "654321" : "123456";
    for (let i = 0; i < 4; i++) await expect(verifyOtp(phone, wrong)).rejects.toMatchObject({ code: "OTP_INVALID" });
    await expect(verifyOtp(phone, wrong)).rejects.toMatchObject({ code: "OTP_LOCKED" });
    await expect(verifyOtp(phone, devCode!)).rejects.toMatchObject({ code: "OTP_LOCKED" });
  });
});

describe("reminders", () => {
  it("queues one reminder for bookings starting within 2 hours", async () => {
    const h = await hold({ times: ["13:00"] });
    await deliverWebhook(webhookBody(h.order!.orderId, "pay_rem", h.order!.amountPaise), "evt_rem");
    const at = new Date(istToUtc(DATE, "13:00").getTime() - 90 * 60_000);
    expect(await sendReminders(at)).toBeGreaterThanOrEqual(1);
    expect(await sendReminders(at)).toBe(0);
    await flushBackground();
    const d = (await getBookingByCode(h.bookingCode))!;
    const rem = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "booking_reminder")));
    expect(rem).toHaveLength(1);
  });
});
