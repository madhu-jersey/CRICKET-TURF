/**
 * P1 hardening: SEC-49 refund retries after an unknown outcome · SEC-50 OTP fallback latency ·
 * SEC-51 file route only serves gallery files, with a per-IP limit.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import sharp from "sharp";
import { setDbOverride, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { AppError } from "@/lib/errors";
import {
  getPaymentProvider,
  ProviderOutcomeUnknown,
  setPaymentProviderOverride,
  webhookSignature,
  type MockPaymentProvider,
  type PaymentProvider,
  type RefundInput,
} from "@/lib/providers/payment";
import { MockProvider, setMessagingProviderOverride, type OutgoingMessage } from "@/lib/providers/messaging";
import {
  cancelBooking,
  createOnlineHold,
  handlePaymentWebhook,
  markRefundedManually,
  reconcileInFlightRefunds,
  refundsNeedingAttention,
  retryPendingRefunds,
  REFUND_GIVE_UP_ATTEMPTS,
} from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import { sendOtp } from "@/lib/otp-service";
import { storeImage } from "@/lib/storage";
import { GET as getFile, FILES_PER_IP_PER_MINUTE } from "@/app/api/files/[id]/route";

let t: TestDb;
let db: DB;
let cricketId: string;
let webhookSecret = "";
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 7);
const LATER = new Date(NOW.getTime() + 2 * 60_000); // past the 1-minute reconcile grace period
let n = 0;

beforeEach(async () => {
  await flushBackground();
  if (t) await t.close();
  t = await createTestDb();
  db = t.db;
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
  webhookSecret = (getPaymentProvider() as MockPaymentProvider).webhookSecret;
});
afterEach(() => {
  setPaymentProviderOverride(undefined);
  setMessagingProviderOverride(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await flushBackground();
  await t?.close();
  setDbOverride(undefined);
});

/** A provider that behaves like the mock but lets each test decide what a refund call does. */
function provider(onRefund: (input: RefundInput, real: MockPaymentProvider, call: number) => Promise<{ refundId: string }>) {
  const real = getPaymentProvider() as MockPaymentProvider;
  const state = { calls: 0 };
  const p: PaymentProvider = {
    name: "mock",
    keyId: real.keyId,
    createOrder: (i) => real.createOrder(i),
    verifyCheckoutSignature: (i) => real.verifyCheckoutSignature(i),
    verifyWebhookSignature: (b, s) => real.verifyWebhookSignature(b, s),
    refund: (i) => onRefund(i, real, ++state.calls),
    listRefunds: (id) => real.listRefunds(id),
  };
  setPaymentProviderOverride(p);
  return state;
}

async function paidThenCancelled(time: string) {
  const h = await createOnlineHold({ courtId: cricketId, date: DATE, times: [time], name: "Refund Key", whatsappOptIn: true, idempotencyKey: `p1-${++n}`, phone: `+9198765${String(49000 + n)}`, deviceId: `dev-p1-${n}` });
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_p1_${n}`, order_id: h.order!.orderId, amount: h.order!.amountPaise } } } });
  await handlePaymentWebhook(body, webhookSignature(body, webhookSecret), `evt_p1_${n}`);
  const id = (await getBookingByCode(h.bookingCode))!.booking.id;
  return { code: h.bookingCode, id, cancel: () => cancelBooking({ bookingId: id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true }) };
}
const booking = async (code: string) => (await getBookingByCode(code))!;

describe("SEC-49 refund retries after an unknown outcome never refund twice", () => {
  it("timeout, but Razorpay did make the refund → recorded by key lookup, no second refund", async () => {
    const b = await paidThenCancelled("09:00");
    const state = provider(async (i, real) => {
      await real.refund(i); // the refund really happens…
      throw new ProviderOutcomeUnknown("Razorpay did not answer: The operation was aborted due to timeout"); // …but we never hear back
    });
    const r = await b.cancel();
    expect(r.refundError).toMatch(/did not answer/);
    let d = await booking(b.code);
    expect(d.payments[0]).toMatchObject({ refundAmount: 300, refundInFlightAmount: 300 }); // reservation kept
    expect(d.payments[0].refundInFlightKey).toMatch(/^rf_/);
    expect(d.booking).toMatchObject({ status: "CANCELLED", refundPendingAmount: 300, refundAttempts: 1 });

    // A retry before reconciling must not call the provider: the refund is still in flight.
    expect(await retryPendingRefunds(LATER)).toBe(0);
    expect(state.calls).toBe(1);

    expect(await reconcileInFlightRefunds(LATER)).toBe(300);
    expect(await retryPendingRefunds(LATER)).toBe(0);
    expect(state.calls).toBe(1);
    d = await booking(b.code);
    expect(d.booking).toMatchObject({ status: "REFUNDED", refundAmount: 300, refundPendingAmount: 0, refundAttempts: 0, refundPendingSince: null });
    expect(d.payments[0]).toMatchObject({ status: "REFUNDED", refundAmount: 300, refundInFlightKey: null });
    expect(d.payments[0].providerRefundId).toMatch(/^rfnd_mock_/);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "payment.refund_reconciled"))).toHaveLength(1);
  });

  it("timeout and no refund at Razorpay → reservation released, retried exactly once", async () => {
    const b = await paidThenCancelled("10:00");
    const state = provider(async (i, real, call) => {
      if (call === 1) throw new ProviderOutcomeUnknown("Razorpay error 504");
      return real.refund(i);
    });
    await b.cancel();
    expect(await reconcileInFlightRefunds(LATER)).toBe(0); // looked up: not there → released
    let d = await booking(b.code);
    expect(d.payments[0]).toMatchObject({ refundAmount: 0, refundInFlightKey: null, status: "PAID" });
    expect(await retryPendingRefunds(LATER)).toBe(300);
    expect(state.calls).toBe(2);
    d = await booking(b.code);
    expect(d.booking).toMatchObject({ status: "REFUNDED", refundPendingAmount: 0 });
    expect(d.payments[0].refundAmount).toBe(300);
  });

  it("in-flight refunds younger than a minute are left alone (the call may still be running)", async () => {
    const b = await paidThenCancelled("11:00");
    provider(async () => {
      throw new ProviderOutcomeUnknown("network error");
    });
    await b.cancel();
    expect(await reconcileInFlightRefunds(new Date())).toBe(0);
    expect((await booking(b.code)).payments[0].refundInFlightKey).not.toBeNull();
  });

  it(`after ${REFUND_GIVE_UP_ATTEMPTS} failed attempts: needs manual refund, retries stop, one owner alert; the owner records it`, async () => {
    const b = await paidThenCancelled("12:00");
    const state = provider(async () => {
      throw new AppError("PROVIDER_ERROR", "BAD_REQUEST_ERROR: The refund amount is invalid");
    });
    await b.cancel(); // attempt 1
    for (let i = 0; i < 30; i++) await retryPendingRefunds(LATER);
    expect(state.calls).toBe(REFUND_GIVE_UP_ATTEMPTS);
    const d = await booking(b.code);
    expect(d.booking).toMatchObject({ refundNeedsManual: true, refundPendingAmount: 300, refundAttempts: REFUND_GIVE_UP_ATTEMPTS });
    await flushBackground();
    await vi.waitFor(async () => {
      const alerts = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.template, "admin_alert"), like(schema.messageLogs.renderedText, "%could not be completed automatically%")));
      expect(alerts).toHaveLength(1);
    });
    expect((await refundsNeedingAttention()).map((r) => r.bookingCode)).toEqual([b.code]);

    expect(await markRefundedManually(b.id, "owner@demo.com")).toBe(300);
    const after = await booking(b.code);
    expect(after.booking).toMatchObject({ status: "REFUNDED", refundNeedsManual: false, refundPendingAmount: 0, refundAmount: 300 });
    expect(after.payments[0]).toMatchObject({ refundAmount: 300, providerRefundId: "manual_owner", status: "REFUNDED" });
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "booking.refund_marked_manual"))).toHaveLength(1);
    expect(await refundsNeedingAttention()).toHaveLength(0);
  });

  it("gives up 24 hours after the first failure even with few attempts", async () => {
    const b = await paidThenCancelled("13:00");
    const state = provider(async () => {
      throw new AppError("PROVIDER_ERROR", "BAD_REQUEST_ERROR");
    });
    await b.cancel();
    await retryPendingRefunds(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(state.calls).toBe(1);
    expect((await booking(b.code)).booking.refundNeedsManual).toBe(true);
  });
});

describe("SEC-50 OTP falls back to SMS fast when WhatsApp is slow", () => {
  it("WhatsApp hangs for 10 s → SMS is used after ~5 s; the request takes under 8 s", async () => {
    vi.stubEnv("OTP_PROVIDER", "whatsapp");
    vi.stubEnv("MSG91_AUTH_KEY", "test-msg91-key");
    vi.stubEnv("MSG91_OTP_TEMPLATE_ID", "test-template");
    class SlowProvider extends MockProvider {
      async send(msg: OutgoingMessage) {
        await new Promise((r) => setTimeout(r, 10_000));
        return super.send(msg);
      }
    }
    setMessagingProviderOverride(new SlowProvider());
    let smsAt = 0;
    const started = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        smsAt = Date.now() - started;
        return new Response("{}", { status: 200 });
      }),
    );
    await sendOtp("+919876549501", "203.0.113.50");
    const total = Date.now() - started;
    expect(smsAt).toBeGreaterThan(4_500);
    expect(smsAt).toBeLessThan(6_500);
    expect(total).toBeLessThan(8_000);
    const [m] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.phone, "+919876549501"));
    expect(m).toMatchObject({ status: "FAILED", attempts: 1 });
  }, 20_000);
});

describe("SEC-51 /api/files only serves gallery files, with a per-IP limit", () => {
  const req = (ip: string) => new Request("http://localhost/api/files/x", { headers: { "x-real-ip": ip } });
  async function stored() {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).png().toBuffer();
    return storeImage(new File([new Uint8Array(png)], "x.png", { type: "image/png" }));
  }

  it("a StoredFile with no GalleryImage is 404; once it belongs to the gallery it's served", async () => {
    const s = await stored();
    const id = s.url.split("/").pop()!;
    expect((await getFile(req("198.51.100.1"), { params: Promise.resolve({ id }) })).status).toBe(404);
    await db.insert(schema.galleryImages).values({ url: s.url, storageKey: s.key, category: "CRICKET", alt: "Nets" });
    expect((await getFile(req("198.51.100.1"), { params: Promise.resolve({ id }) })).status).toBe(200);
  });

  it(`the ${FILES_PER_IP_PER_MINUTE}-per-minute limit holds per network`, async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const statuses: number[] = [];
    for (let i = 0; i < FILES_PER_IP_PER_MINUTE + 1; i++) statuses.push((await getFile(req("198.51.100.2"), { params: Promise.resolve({ id }) })).status);
    expect(statuses.filter((s) => s === 404)).toHaveLength(FILES_PER_IP_PER_MINUTE);
    expect(statuses.at(-1)).toBe(429);
    expect((await getFile(req("198.51.100.3"), { params: Promise.resolve({ id }) })).status).toBe(404); // another network is unaffected
  }, 60_000);
});
