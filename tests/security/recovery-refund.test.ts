/**
 * SEC-41 (admin 2FA recovery codes) and SEC-43 (fresh OTP for cancels that refund money).
 * Server logic on a real Postgres engine (PGlite by default, or TEST_DATABASE_URL).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { setDbOverride, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, webhookSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import { cancelBooking, createOnlineHold, handlePaymentWebhook, createAdminBooking } from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import {
  ensureRecoveryCodes,
  generateRecoveryCodes,
  issueAdminCode,
  normalizeRecoveryCode,
  recoveryCodesLeft,
  RECOVERY_CODE_COUNT,
  verifyRecoveryLogin,
} from "@/lib/auth/admin-core";
import { FRESH_OTP_MS, isFreshOtp, issuePhoneToken, readPhoneProof } from "@/lib/auth/phone";
import { signToken } from "@/lib/security";
import { env } from "@/lib/env";

let t: TestDb;
let db: DB;
let cricketId: string;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 9);
let n = 0;

beforeEach(async () => {
  await flushBackground();
  if (t) await t.close();
  t = await createTestDb();
  db = t.db;
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
});
afterAll(async () => {
  await flushBackground();
  await t?.close();
  setDbOverride(undefined);
});

const err = (p: Promise<unknown>) => p.then(() => "OK").catch((e: { code?: string; message?: string }) => e.code ?? e.message ?? "THROW");
const adminBy = async (email: string) => (await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email)))[0];
const audits = (action: string) => db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));

describe("SEC-41 admin recovery codes", () => {
  it("10 distinct codes, shown once, stored only as hashes", async () => {
    const o = await adminBy("owner@demo.com");
    const codes = await generateRecoveryCodes(o.id, o.email, "setup");
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const rows = await db.select().from(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, o.id));
    expect(rows).toHaveLength(10);
    const stored = JSON.stringify(rows);
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(c.replace("-", ""));
    }
    expect(await audits("admin.recovery_codes_created")).toHaveLength(1);
  });

  it("first two-step login makes the set exactly once", async () => {
    const o = await adminBy("owner@demo.com");
    const [first, second] = await Promise.all([ensureRecoveryCodes(o), ensureRecoveryCodes(o)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await ensureRecoveryCodes(await adminBy("owner@demo.com"))).toBeUndefined();
    expect(await recoveryCodesLeft(o.id)).toBe(10);
  });

  it("a code works once instead of the phone code; it's audit-logged and the owner is alerted", async () => {
    const s = await adminBy("staff@demo.com");
    const codes = await generateRecoveryCodes(s.id, s.email, "setup");
    const ch = await issueAdminCode(s, "LOGIN", { ip: "203.0.113.9" });
    // Lower case and no dash are accepted.
    const r = await verifyRecoveryLogin(ch.challengeId, codes[3].toLowerCase().replace("-", " "));
    expect(r.admin.id).toBe(s.id);
    expect(r.left).toBe(9);
    // The challenge is used up, and the same code can't be used again with a new challenge.
    expect(await err(verifyRecoveryLogin(ch.challengeId, codes[4]))).toBe("OTP_INVALID");
    const ch2 = await issueAdminCode(s, "LOGIN");
    expect(await err(verifyRecoveryLogin(ch2.challengeId, codes[3]))).toBe("OTP_INVALID");
    expect(await recoveryCodesLeft(s.id)).toBe(9);

    const [a] = await audits("admin.recovery_code_used");
    expect(a.actor).toBe("staff@demo.com");
    await vi.waitFor(async () => {
      const alerts = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.template, "admin_alert"));
      expect(alerts.some((m) => m.renderedText.includes("recovery code was used") && m.renderedText.includes("staff@demo.com"))).toBe(true);
    });
  });

  it("a code for admin A can't complete admin B's login", async () => {
    const o = await adminBy("owner@demo.com");
    const s = await adminBy("staff@demo.com");
    const ownerCodes = await generateRecoveryCodes(o.id, o.email, "setup");
    await generateRecoveryCodes(s.id, s.email, "setup");
    const ch = await issueAdminCode(s, "LOGIN");
    expect(await err(verifyRecoveryLogin(ch.challengeId, ownerCodes[0]))).toBe("OTP_INVALID");
    expect(await recoveryCodesLeft(o.id)).toBe(10); // not burned
  });

  it("needs a live password challenge, and locks after 5 wrong tries", async () => {
    const o = await adminBy("owner@demo.com");
    const codes = await generateRecoveryCodes(o.id, o.email, "setup");
    expect(await err(verifyRecoveryLogin("no-such-challenge", codes[0]))).toBe("OTP_INVALID");
    const expired = await issueAdminCode(o, "LOGIN", {}, new Date(NOW.getTime() - 10 * 60_000));
    expect(await err(verifyRecoveryLogin(expired.challengeId, codes[0]))).toBe("OTP_INVALID");

    const ch = await issueAdminCode(o, "LOGIN");
    for (let i = 0; i < 5; i++) expect(await err(verifyRecoveryLogin(ch.challengeId, "AAAAA-AAAAA"))).toBe("OTP_INVALID");
    expect(await err(verifyRecoveryLogin(ch.challengeId, codes[0]))).toBe("OTP_LOCKED");
    expect(await recoveryCodesLeft(o.id)).toBe(10);
  });

  it("regenerating replaces every old code", async () => {
    const o = await adminBy("owner@demo.com");
    const old = await generateRecoveryCodes(o.id, o.email, "setup");
    const fresh = await generateRecoveryCodes(o.id, o.email, "regenerate");
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    const ch = await issueAdminCode(o, "LOGIN");
    expect(await err(verifyRecoveryLogin(ch.challengeId, old[0]))).toBe("OTP_INVALID");
    expect((await verifyRecoveryLogin(ch.challengeId, fresh[0])).admin.id).toBe(o.id);
    expect(await audits("admin.recovery_codes_regenerated")).toHaveLength(1);
    const unused = await db.select().from(schema.adminRecoveryCodes).where(and(eq(schema.adminRecoveryCodes.adminId, o.id), isNull(schema.adminRecoveryCodes.usedAt)));
    expect(unused).toHaveLength(9);
  });

  it("normalizes input and rejects anything that can't be a code", () => {
    expect(normalizeRecoveryCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("ABCDE-FGHJ0")).toBeNull(); // 0 isn't in the alphabet
    expect(normalizeRecoveryCode("123456")).toBeNull();
  });
});

describe("SEC-43 refunds need a fresh OTP", () => {
  const mock = () => getPaymentProvider() as MockPaymentProvider;
  async function paidBooking(time: string) {
    const h = await createOnlineHold({ courtId: cricketId, date: DATE, times: [time], name: "Refund Test", whatsappOptIn: true, idempotencyKey: `rf-${++n}`, phone: `+9198765${String(43000 + n)}`, deviceId: `dev-rf-${n}` });
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${h.bookingCode}`, order_id: h.order!.orderId, amount: h.order!.amountPaise, status: "captured" } } } });
    await handlePaymentWebhook(body, webhookSignature(body, mock().webhookSecret), `evt_${h.bookingCode}`);
    return (await getBookingByCode(h.bookingCode))!;
  }

  it("a cancel that would refund is refused without a fresh code, and nothing changes", async () => {
    const d = await paidBooking("10:00");
    expect(await err(cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } }))).toBe("FRESH_OTP_REQUIRED");
    const after = (await getBookingByCode(d.booking.bookingCode))!;
    expect(after.booking.status).toBe("CONFIRMED");
    expect(after.payments[0].refundAmount).toBe(0);
    const r = await cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: true });
    expect(r).toMatchObject({ status: "REFUNDED", refunded: 300 });
  });

  it("a cancel with nothing to refund keeps working on a remembered device", async () => {
    // Inside the refund cutoff: nothing is refunded, so no new code is needed.
    const d = await paidBooking("12:00");
    const inside = new Date(d.booking.startAt.getTime() - 60 * 60_000);
    expect((await cancelBooking({ bookingId: d.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } }, inside)).refunded).toBe(0);
    // A walk-in with no online payment: same.
    const w = await createAdminBooking({ courtId: cricketId, date: DATE, times: ["14:00"], name: "Walk In", phone: "+919876500001", whatsappOptIn: false, source: "WALK_IN", amountReceived: 0, paymentMode: "CASH" }, "staff@demo.com");
    const wb = (await getBookingByCode(w.bookingCode))!;
    expect((await cancelBooking({ bookingId: wb.booking.id, actor: "c", by: "CUSTOMER", refund: { mode: "POLICY" } })).refunded).toBe(0);
  });

  it("staff/owner cancels are not affected", async () => {
    const d = await paidBooking("16:00");
    expect((await cancelBooking({ bookingId: d.booking.id, actor: "owner@demo.com", by: "ADMIN", refund: { mode: "FULL" } })).refunded).toBe(300);
  });

  it("only a code typed in the last 10 minutes counts as fresh", () => {
    const now = Date.now();
    const otp = readPhoneProof(issuePhoneToken("+919876543210", now, "otp"));
    const device = readPhoneProof(issuePhoneToken("+919876543210", now, "trusted"));
    expect(isFreshOtp(otp, now)).toBe(true);
    expect(isFreshOtp(device, now)).toBe(false);
    expect(isFreshOtp(otp, now + FRESH_OTP_MS + 1)).toBe(false);
    // Tokens issued before this change (no "via") are treated as device-verified.
    const legacy = readPhoneProof(signToken({ phone: "+919876543210", exp: now + 60_000, purpose: "phone" }, env.appSecret));
    expect(legacy?.phone).toBe("+919876543210");
    expect(isFreshOtp(legacy, now)).toBe(false);
  });
});
