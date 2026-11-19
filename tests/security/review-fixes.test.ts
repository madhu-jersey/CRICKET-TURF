/**
 * Fixes for the defects found while writing docs/ARCHITECTURE.md:
 * SEC-44 gallery files served from the DB · SEC-45 failed refunds recorded + retried ·
 * SEC-46 OTP delivery failures surface (and fall back to SMS) · SEC-47 is in tests/concurrency.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { setDbOverride, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, setPaymentProviderOverride, webhookSignature, type MockPaymentProvider, type PaymentProvider } from "@/lib/providers/payment";
import { MockProvider, setMessagingProviderOverride } from "@/lib/providers/messaging";
import { cancelBooking, createOnlineHold, handlePaymentWebhook, refundCancelledBooking, retryPendingRefunds } from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import { AppError } from "@/lib/errors";
import { sendOtp } from "@/lib/otp-service";
import { issueAdminCode } from "@/lib/auth/admin-core";
import { storeImage } from "@/lib/storage";
import { GET as getFile } from "@/app/api/files/[id]/route";

let t: TestDb;
let db: DB;
let cricketId: string;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 8);
let n = 0;
let webhookSecret = "";

beforeEach(async () => {
  await flushBackground();
  if (t) await t.close();
  t = await createTestDb();
  db = t.db;
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
  webhookSecret = mock().webhookSecret; // read before any test swaps the provider
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

const err = (p: Promise<unknown>) => p.then(() => "OK").catch((e: { code?: string; message?: string }) => e.code ?? e.message ?? "THROW");
const audits = (action: string) => db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));
const mock = () => getPaymentProvider() as MockPaymentProvider;

/** The real mock provider, except refunds fail while `failing` is true. Counts refund calls. */
function flakyRefunds() {
  const real = mock();
  const state = { failing: true, calls: 0 };
  const p: PaymentProvider = {
    name: "mock",
    keyId: real.keyId,
    createOrder: (i) => real.createOrder(i),
    verifyCheckoutSignature: (i) => real.verifyCheckoutSignature(i),
    verifyWebhookSignature: (b, s) => real.verifyWebhookSignature(b, s),
    refund: async (i) => {
      state.calls++;
      if (state.failing) throw new AppError("PROVIDER_ERROR", "Razorpay: BAD_REQUEST_ERROR (simulated)");
      return real.refund(i);
    },
    listRefunds: (id) => real.listRefunds(id),
  };
  setPaymentProviderOverride(p);
  return state;
}

const hold = (time: string, now = NOW) =>
  createOnlineHold(
    { courtId: cricketId, date: DATE, times: [time], name: "Fix Test", whatsappOptIn: true, idempotencyKey: `fx-${++n}`, phone: `+9198765${String(44000 + n)}`, deviceId: `dev-fx-${n}` },
    now,
  );
async function pay(orderId: string, amountPaise: number, id: string) {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${id}`, order_id: orderId, amount: amountPaise } } } });
  return handlePaymentWebhook(body, webhookSignature(body, webhookSecret), `evt_${id}`);
}

describe("SEC-45 failed refunds are recorded and retried", () => {
  it("late payment for a taken slot: refund fails → webhook still succeeds, refund pending, owner alerted; the cron retry pays it", async () => {
    const early = await hold("10:00", new Date(NOW.getTime() - 30 * 60_000)); // its hold expired 20 min ago
    await hold("10:00"); // someone else takes the slot
    const state = flakyRefunds();
    const r = await pay(early.order!.orderId, early.order!.amountPaise, "late1");
    expect(r.duplicate).toBe(false);
    expect((r.result as { outcome: string }).outcome).toBe("REFUND_SLOT_TAKEN");

    let d = (await getBookingByCode(early.bookingCode))!;
    expect(d.booking.status).toBe("CANCELLED");
    expect(d.booking.refundPendingAmount).toBe(300);
    expect(d.payments[0]).toMatchObject({ status: "PAID", refundAmount: 0 }); // reservation released
    expect(await audits("booking.refund_failed")).toHaveLength(1);
    await vi.waitFor(async () => {
      const alerts = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.template, "admin_alert"));
      expect(alerts.some((m) => m.renderedText.includes(early.bookingCode) && m.renderedText.includes("failed"))).toBe(true);
    });

    // Still failing: the amount is put back for the next run.
    expect(await retryPendingRefunds()).toBe(0);
    expect((await getBookingByCode(early.bookingCode))!.booking.refundPendingAmount).toBe(300);

    state.failing = false;
    expect(await retryPendingRefunds()).toBe(300);
    d = (await getBookingByCode(early.bookingCode))!;
    expect(d.booking).toMatchObject({ status: "REFUNDED", refundAmount: 300, refundPendingAmount: 0 });
    expect(d.payments[0]).toMatchObject({ status: "REFUNDED", refundAmount: 300 });
    expect(await retryPendingRefunds()).toBe(0); // nothing left
    await flushBackground();
    const sent = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "booking_cancelled")));
    expect(sent).toHaveLength(1);
  });

  it("customer cancel: a failed refund is pending, not lost; a manual owner refund settles it so the cron can't pay twice", async () => {
    const h = await hold("12:00");
    await pay(h.order!.orderId, h.order!.amountPaise, "c1");
    const id = (await getBookingByCode(h.bookingCode))!.booking.id;
    const state = flakyRefunds();
    const r = await cancelBooking({ bookingId: id, actor: "customer", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true });
    expect(r).toMatchObject({ status: "CANCELLED", refunded: 0 });
    expect(r.refundError).toMatch(/BAD_REQUEST_ERROR/);
    expect((await getBookingByCode(h.bookingCode))!.booking.refundPendingAmount).toBe(300);

    // Provider failing: the owner's manual refund reports the error and changes nothing.
    expect(await err(refundCancelledBooking(id, 300, "owner@demo.com"))).toBe("PROVIDER_ERROR");
    state.failing = false;
    expect(await refundCancelledBooking(id, 300, "owner@demo.com")).toBe(300);
    const d = (await getBookingByCode(h.bookingCode))!;
    expect(d.booking).toMatchObject({ status: "REFUNDED", refundPendingAmount: 0 });
    const callsBefore = state.calls;
    expect(await retryPendingRefunds()).toBe(0);
    expect(state.calls).toBe(callsBefore);
    expect(d.payments[0].refundAmount).toBe(300);
  });
});

describe("SEC-46 OTP delivery failures surface instead of 'code sent'", () => {
  function whatsappDown() {
    vi.stubEnv("OTP_PROVIDER", "whatsapp");
    const p = new MockProvider();
    p.failNext = 1000;
    setMessagingProviderOverride(p);
  }
  function msg91() {
    vi.stubEnv("MSG91_AUTH_KEY", "test-msg91-key");
    vi.stubEnv("MSG91_OTP_TEMPLATE_ID", "test-template");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: "success" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("WhatsApp down and no SMS backup: the customer gets an error and the undelivered code is withdrawn", async () => {
    whatsappDown();
    expect(await err(sendOtp("+919876544101", "203.0.113.5"))).toBe("PROVIDER_ERROR");
    const [row] = await db.select().from(schema.otpRequests).where(eq(schema.otpRequests.phone, "+919876544101"));
    expect(row.consumedAt).not.toBeNull();
    const [m] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.phone, "+919876544101"));
    expect(m.status).toBe("FAILED");
    expect(m.attempts).toBe(1); // one try with a 5 s deadline, then give up (SEC-50)
  });

  it("WhatsApp down with MSG91 configured: the customer's code goes by SMS", async () => {
    whatsappDown();
    const fetchMock = msg91();
    await sendOtp("+919876544102", "203.0.113.5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("control.msg91.com");
    const [row] = await db.select().from(schema.otpRequests).where(eq(schema.otpRequests.phone, "+919876544102"));
    expect(row.consumedAt).toBeNull();
  });

  it("admin login codes fall back to SMS when WhatsApp fails, and fail loudly without a backup", async () => {
    const [owner] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "owner@demo.com"));
    whatsappDown();
    expect(await err(issueAdminCode(owner, "LOGIN"))).toBe("PROVIDER_ERROR");
    const fetchMock = msg91();
    const c = await issueAdminCode(owner, "LOGIN");
    expect(c.challengeId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SEC-44 gallery files stored in the database are served", () => {
  it("an uploaded image is re-encoded, stored and served back as WebP; bad or unknown ids are 404", async () => {
    const png = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#1a4d30" } }).png().toBuffer();
    const stored = await storeImage(new File([new Uint8Array(png)], "pitch.png", { type: "image/png" }));
    expect(stored.url).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
    const id = stored.url.split("/").pop()!;
    // Only files that belong to a gallery image are served (SEC-51).
    await db.insert(schema.galleryImages).values({ url: stored.url, storageKey: stored.key, category: "FACILITIES", alt: "Pitch at night" });

    const res = await getFile(new Request(`http://localhost${stored.url}`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...body.slice(8, 12))).toBe("WEBP");
    expect((await sharp(body).metadata()).width).toBe(320);

    const unknown = await getFile(new Request("http://localhost/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(unknown.status).toBe(404);
    const bad = await getFile(new Request("http://localhost/x"), { params: Promise.resolve({ id: "../../etc/passwd" }) });
    expect(bad.status).toBe(404);
  });
});
