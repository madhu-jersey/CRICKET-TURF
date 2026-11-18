/**
 * Security regression tests (server logic, real Postgres via in-memory PGlite, real constraints).
 * Each block names the finding ID from SECURITY_REPORT.md it protects.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { createPgliteDb, setDbOverride, schema, type DB } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey, istToUtc } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, resetPaymentProviderCache, webhookSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import { BLOCKED_MESSAGE, cancelBooking, createAdminBooking, createOnlineHold, handlePaymentWebhook, setBookingOutcome } from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import { sendOtp } from "@/lib/otp-service";
import { hitRateLimit, ipFromHeaders } from "@/lib/ratelimit";
import { normalizeIndianPhone, createBookingSchema } from "@/lib/validation";
import { cleanParam, renderTemplate } from "@/lib/messaging/templates";
import { csvCell } from "@/lib/csv";
import { configProblems } from "@/lib/startup-checks";
import { readJson } from "@/lib/errors";
import { sanitizeImage } from "@/lib/storage";
import { MockOtp } from "@/lib/providers/otp";
import { env } from "@/lib/env";

let db: DB;
let close: () => Promise<void>;
let cricketId: string;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 10);
let n = 0;

beforeEach(async () => {
  await flushBackground();
  if (close) await close();
  ({ db, close } = await createPgliteDb("memory://"));
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
  await db.delete(schema.blockedSlots).where(eq(schema.blockedSlots.courtId, cricketId));
});
afterAll(async () => {
  await flushBackground();
  await close?.();
  setDbOverride(undefined);
});

const phoneN = () => `+9197${String(10000000 + ++n).slice(-8)}`;
const hold = (over: Partial<Parameters<typeof createOnlineHold>[0]> = {}, now = NOW) =>
  createOnlineHold({ courtId: cricketId, date: DATE, times: ["20:00"], name: "Sec Test", whatsappOptIn: true, idempotencyKey: `sec-${++n}-${Math.random()}`, phone: phoneN(), deviceId: `dev-${n}-${Math.random()}`, ...over }, now);
const errCode = (p: Promise<unknown>) => p.then(() => "OK").catch((e: { code?: string }) => e.code ?? "THROW");

describe("SEC-04 booking races", () => {
  it("50 parallel bookings for one slot → exactly 1 succeeds, 49 'slot taken'", async () => {
    const r = await Promise.all(Array.from({ length: 50 }, () => errCode(hold())));
    expect(r.filter((x) => x === "OK")).toHaveLength(1);
    expect(r.filter((x) => x === "SLOT_TAKEN")).toHaveLength(49);
  });

  it("overlapping ranges 6–8 and 7–9 requested together → one rejected", async () => {
    const r = await Promise.all([errCode(hold({ times: ["06:00", "07:00"] })), errCode(hold({ times: ["07:00", "08:00"] }))]);
    expect(r.sort()).toEqual(["OK", "SLOT_TAKEN"]);
  });

  it("the exclusion constraint exists in the migrated database", async () => {
    const res = (await db.execute(`select conname from pg_constraint where conname = 'no_overlap'` as never)) as unknown as { rows: unknown[] };
    expect(res.rows).toHaveLength(1);
  });

  it("walk-in on a held slot is rejected", async () => {
    await hold({ times: ["21:00"] });
    await expect(
      createAdminBooking({ courtId: cricketId, date: DATE, times: ["21:00"], name: "Walk", phone: "+919800000001", whatsappOptIn: false, source: "WALK_IN", amountReceived: 0, paymentMode: "CASH" }, "owner@demo.com"),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
  });

  it("booking outside the rules is rejected server-side", async () => {
    expect(await errCode(hold({ times: ["05:00"] }))).toBe("VALIDATION"); // before opening
    expect(await errCode(hold({ times: ["18:00", "20:00"] }))).toBe("VALIDATION"); // not consecutive
    expect(await errCode(hold({ date: addDays(istDateKey(NOW), 40) }))).toBe("VALIDATION"); // beyond max days ahead
    expect(await errCode(hold({ date: addDays(istDateKey(NOW), -1) }))).toBe("VALIDATION"); // past day
    await db.insert(schema.blockedSlots).values({ courtId: cricketId, startAt: istToUtc(DATE, "09:00"), endAt: istToUtc(DATE, "10:00"), reason: "MAINTENANCE", createdBy: "t" });
    expect(await errCode(hold({ times: ["09:00"] }))).toBe("SLOT_TAKEN"); // blocked
    await db.update(schema.courts).set({ isActive: false }).where(eq(schema.courts.id, cricketId));
    expect(await errCode(hold({ times: ["11:00"] }))).toBe("NOT_FOUND"); // inactive court
  });
});

describe("SEC-10 slot squatting limits", () => {
  it("max 2 upcoming bookings per number", async () => {
    const phone = "+919811122233";
    await hold({ phone, times: ["06:00"] });
    await hold({ phone, times: ["07:00"] });
    await expect(hold({ phone, times: ["08:00"] })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("max new bookings per number per day counts cancelled ones (book-and-cancel cycling)", async () => {
    const phone = "+919811122244";
    await db.update(schema.settings).set({ maxActiveBookingsPerPhone: 10, maxBookingsPerPhonePerDay: 2 });
    for (const t of ["06:00", "07:00"]) {
      const h = await hold({ phone, times: [t] });
      const d = (await getBookingByCode(h.bookingCode))!;
      await cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } });
    }
    await expect(hold({ phone, times: ["08:00"] })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("SEC-12 no-show blocking", () => {
  it("3 no-shows block the number, in every phone format", async () => {
    const phone = "+919822233344";
    const [c] = await db.insert(schema.customers).values({ name: "No Show", phone }).returning();
    const past = addDays(istDateKey(NOW), -3);
    for (let i = 0; i < 3; i++) {
      const [b] = await db
        .insert(schema.bookings)
        .values({ bookingCode: `BBA-NS00000${i}`, customerId: c.id, courtId: cricketId, startAt: istToUtc(past, (8 + i) * 60), endAt: istToUtc(past, (9 + i) * 60), status: "CONFIRMED", totalAmount: 800, advanceAmount: 300, balanceAmount: 500, source: "ONLINE" })
        .returning();
      await setBookingOutcome(b.id, "NO_SHOW", "owner@demo.com");
    }
    const [after] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id));
    expect(after.isBlocked).toBe(true);
    for (const variant of ["9822233344", "+91 98222 33344", "098222-33344", "919822233344"]) {
      const normalized = normalizeIndianPhone(variant)!;
      expect(normalized).toBe(phone);
      await expect(hold({ phone: normalized, times: ["06:00"] })).rejects.toThrow(BLOCKED_MESSAGE);
    }
  });
});

describe("SEC-23 cancellation", () => {
  async function confirmed(times = ["13:00"]) {
    const h = await hold({ times });
    const p = getPaymentProvider() as MockPaymentProvider;
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${h.bookingCode}`, order_id: h.order!.orderId, amount: h.order!.amountPaise } } } });
    await handlePaymentWebhook(body, webhookSignature(body, p.webhookSecret), `evt_${h.bookingCode}`);
    return (await getBookingByCode(h.bookingCode))!;
  }

  it("double cancel in parallel → one cancellation, one refund, one message", async () => {
    const d = await confirmed();
    const r = await Promise.all([1, 2].map(() => errCode(cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } }))));
    expect(r.sort()).toEqual(["NOT_ALLOWED", "OK"]);
    await flushBackground();
    const after = (await getBookingByCode(d.booking.bookingCode))!;
    expect(after.payments[0].refundAmount).toBe(300);
    const msgs = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, d.booking.id), eq(schema.messageLogs.template, "booking_cancelled")));
    expect(msgs).toHaveLength(1);
  });

  it("refund cutoff is enforced on the server (no refund inside 2 h, no online cancel after start)", async () => {
    const d = await confirmed(["14:00"]);
    const inside = new Date(d.booking.startAt.getTime() - 60 * 60_000);
    expect((await cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } }, inside)).refunded).toBe(0);
    const d2 = await confirmed(["15:00"]);
    const afterStart = new Date(d2.booking.startAt.getTime() + 60_000);
    expect(await errCode(cancelBooking({ bookingId: d2.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } }, afterStart))).toBe("NOT_ALLOWED");
  });
});

describe("SEC-07/08 OTP flooding and rate limiting", () => {
  it("rate limiter is atomic: 20 parallel hits with limit 5 → exactly 5 allowed", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit("sec-test", 5, 60_000)));
    expect(r.filter(Boolean)).toHaveLength(5);
  });

  it("10 parallel sends to one number → only 3 codes issued", async () => {
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) => errCode(sendOtp("+919833300011", `10.0.0.${i}`))));
    expect(r.filter((x) => x === "OK")).toHaveLength(3);
    const rows = await db.select().from(schema.otpRequests).where(eq(schema.otpRequests.phone, "+919833300011"));
    expect(rows).toHaveLength(3);
  });

  it("global daily cap stops sends across many numbers/networks and alerts the owner once", async () => {
    await db.update(schema.settings).set({ otpDailyCap: 10 });
    const r: string[] = [];
    for (let i = 0; i < 13; i++) r.push(await errCode(sendOtp(`+91984440${String(1000 + i)}`, `10.1.${i}.1`)));
    expect(r.filter((x) => x === "OK")).toHaveLength(10);
    expect(r.slice(10)).toEqual(["RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED"]);
    await flushBackground();
    await new Promise((res) => setTimeout(res, 50));
    const alerts = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.template, "admin_alert"));
    expect(alerts).toHaveLength(1);
  });

  it("phone formatting tricks map to one number (one per-number limit)", () => {
    const forms = ["9876543210", "+919876543210", "+91 98765 43210", "09876543210", "91-98765-43210"];
    expect(new Set(forms.map(normalizeIndianPhone))).toEqual(new Set(["+919876543210"]));
  });
});

describe("SEC-06 client IP can't be spoofed with X-Forwarded-For", () => {
  it("uses the platform header, else the right-most (proxy-added) XFF entry", () => {
    expect(ipFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(ipFromHeaders(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(ipFromHeaders(new Headers({ "x-vercel-forwarded-for": "192.0.2.1", "x-forwarded-for": "6.6.6.6" }))).toBe("192.0.2.1");
  });
});

describe("SEC-01/02 mock providers and secrets are off on a live site", () => {
  const saved = { ...process.env };
  const live = () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.DEMO_MODE = "false";
    process.env.APP_SECRET = "x".repeat(40);
    resetPaymentProviderCache();
  };
  const restore = () => {
    for (const k of ["NODE_ENV", "DEMO_MODE", "APP_SECRET"]) (process.env as Record<string, string | undefined>)[k] = saved[k];
    resetPaymentProviderCache();
  };

  it("mock payment provider and the simulate endpoint are refused", async () => {
    live();
    try {
      expect(() => getPaymentProvider()).toThrow(/not configured/);
      const { POST } = await import("@/app/api/payments/mock/simulate/route");
      const res = await POST(new Request("http://x/api/payments/mock/simulate", { method: "POST", body: JSON.stringify({ orderId: "order_x", outcome: "success" }) }));
      expect(res.status).toBe(404);
    } finally {
      restore();
    }
  });

  it("mock OTP (code on screen) is refused", async () => {
    live();
    try {
      await expect(new MockOtp().send("+919800000099", "123456")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    } finally {
      restore();
    }
  });

  it("APP_SECRET is mandatory in production even in demo mode", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.APP_SECRET = "";
    try {
      expect(() => env.appSecret).toThrow(/APP_SECRET/);
    } finally {
      restore();
    }
  });

  it("startup check lists every unsafe live setting", () => {
    const problems = configProblems({ NODE_ENV: "production", DEMO_MODE: "false", PAYMENT_PROVIDER: "mock", OTP_PROVIDER: "mock" });
    expect(problems.join(" ")).toMatch(/APP_SECRET.*CRON_SECRET.*DATABASE_URL.*PAYMENT_PROVIDER.*OTP_PROVIDER.*NEXT_PUBLIC_SITE_URL/);
    expect(configProblems({ NODE_ENV: "production", DEMO_MODE: "true" })).toEqual([]);
  });
});

describe("SEC-05/11 booking codes and phone privacy", () => {
  it("new booking codes are 8 random characters", async () => {
    const h = await hold();
    expect(h.bookingCode).toMatch(/^BBA-[A-HJ-NP-Z2-9]{8}$/);
  });

  it("anyone holding the code does not get the customer's phone number", async () => {
    const h = await hold();
    const { holdResponseFor } = await import("@/lib/booking/service");
    const anon = await holdResponseFor(h.bookingCode, null);
    expect(anon.prefill.phone).toBe("");
    expect(anon.prefill.name).toBe("Sec");
  });
});

describe("SEC-15/22/19 injection and input handling", () => {
  it("mass-assignment fields are stripped from booking input", () => {
    const parsed = createBookingSchema.parse({ courtId: "c", date: "2026-12-01", times: ["18:00"], name: "A B", whatsappOptIn: true, acceptTerms: true, idempotencyKey: "12345678", status: "CONFIRMED", totalAmount: 1, advanceAmount: 0, source: "WALK_IN", role: "OWNER" });
    expect(Object.keys(parsed).sort()).toEqual(["acceptTerms", "courtId", "date", "idempotencyKey", "name", "times", "whatsappOptIn"]);
  });

  it("WhatsApp params can't break the template or add links", () => {
    expect(cleanParam("Ravi\n\nVisit http://evil.example now\twww.bad.example", "name")).toBe("Ravi Visit evil.example now bad.example");
    expect(renderTemplate("booking_cancelled", { name: "X\nY", code: "C", date: "d", time: "t", refund: "r" })).not.toMatch(/X\nY/);
  });

  it("CSV cells can't run as spreadsheet formulas", () => {
    for (const evil of ["=HYPERLINK(\"x\")", "+1+1", "-2", "@SUM(A1)", "  =cmd"]) expect(csvCell(evil)).toMatch(/^"'/);
    expect(csvCell('a "quoted" name')).toBe('"a ""quoted"" name"');
  });

  it("oversized JSON bodies are rejected", async () => {
    const big = JSON.stringify({ x: "a".repeat(40_000) });
    await expect(readJson(new Request("http://x", { method: "POST", body: big }))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("SEC-20 image uploads", () => {
  it("re-encoding strips EXIF/GPS metadata", async () => {
    const withGps = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#0b2a19" } })
      .jpeg()
      .withExifMerge({ IFD0: { Copyright: "secret-location" }, GPS: { GPSLatitudeRef: "N" } } as never)
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const clean = await sanitizeImage(new Uint8Array(withGps));
    const meta = await sharp(clean).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
  });

  it("rejects non-images even with an image extension", async () => {
    const { storeImage } = await import("@/lib/storage");
    const html = new File(["<html><script>alert(1)</script></html>"], "photo.jpg.html", { type: "image/jpeg" });
    await expect(storeImage(html)).rejects.toMatchObject({ code: "VALIDATION" });
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], "x.svg", { type: "image/svg+xml" });
    await expect(storeImage(svg)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
