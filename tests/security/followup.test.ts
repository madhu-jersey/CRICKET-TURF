/**
 * Regression tests for the follow-up findings (SEC-33 onward). Server logic on a real Postgres engine
 * (PGlite by default, or TEST_DATABASE_URL). HTTP-level checks live in http.spec.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { setDbOverride, schema, type DB } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { createOnlineHold } from "@/lib/booking/service";
import { listCourts } from "@/lib/booking/data";
import { otpCapUsage, sendOtp } from "@/lib/otp-service";
import { issueTrustToken, checkTrustToken } from "@/lib/auth/trusted-device";
import { checkSiteverify } from "@/lib/turnstile";
import { configProblems, configWarnings } from "@/lib/startup-checks";
import { enforceIpLimit, maskIp, NETWORK_LIMIT_MESSAGE } from "@/lib/ip-limits";
import { PgCounterStore, windowLimit } from "@/lib/counter";
import { availabilityComputeCount, clearAvailabilityCache, getCachedAvailability } from "@/lib/booking/availability-cache";
import { changePassword, createStaff, issueAdminCode, manageStaff, requestPasswordReset, resetPasswordWithCode, verifyAdminCode } from "@/lib/auth/admin-core";
import { passwordProblem } from "@/lib/auth/passwords";
import { policyLines, policySummary, refundFor, cancelledRefundText } from "@/lib/policy";
import { renderTemplate } from "@/lib/messaging/templates";
import { assertSafeTestUrl } from "../support/test-db";
import { createTestDb, type TestDb } from "../support/test-db";
import bcrypt from "bcryptjs";

let t: TestDb;
let db: DB;
let cricketId: string;
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 10);
let n = 0;

beforeEach(async () => {
  await flushBackground();
  if (t) await t.close();
  t = await createTestDb();
  db = t.db;
  setDbOverride(db);
  await seedDatabase(db, NOW);
  cricketId = (await listCourts(db)).find((c) => c.sport === "CRICKET")!.id;
  clearAvailabilityCache();
});
afterAll(async () => {
  await flushBackground();
  await t?.close();
  setDbOverride(undefined);
});

const err = (p: Promise<unknown>) => p.then(() => "OK").catch((e: { code?: string; message?: string }) => e.code ?? e.message ?? "THROW");

describe("SEC-33 test database safety", () => {
  it("refuses production-looking TEST_DATABASE_URLs", () => {
    expect(() => assertSafeTestUrl("postgres://u:p@db.prod.example.com/x", {})).toThrow(/allowlist/);
    expect(() => assertSafeTestUrl("postgres://u:p@localhost/x", { DATABASE_URL: "postgres://u:p@localhost/x" })).toThrow(/must not equal/);
    expect(() => assertSafeTestUrl("postgres://u:p@localhost/x", { NODE_ENV: "production" })).toThrow(/production/);
    expect(() => assertSafeTestUrl("postgres://u:p@staging.db.example/x", { TEST_DB_ALLOWED_HOSTS: "staging.db.example" })).not.toThrow();
  });
});

describe("SEC-34 split OTP caps", () => {
  async function makeReturning(phone: string) {
    const [c] = await db.insert(schema.customers).values({ name: "Regular", phone }).returning();
    await db.insert(schema.bookings).values({
      bookingCode: `BBA-RT${String(++n).padStart(6, "0")}`,
      customerId: c.id,
      courtId: cricketId,
      startAt: new Date(NOW.getTime() - 5 * 86_400_000),
      endAt: new Date(NOW.getTime() - 5 * 86_400_000 + 3_600_000),
      status: "COMPLETED",
      totalAmount: 800,
      advanceAmount: 300,
      balanceAmount: 500,
      source: "ONLINE",
    });
  }

  it("exhausting the new-number pool doesn't block a returning customer", async () => {
    await db.update(schema.settings).set({ otpDailyCapNew: 10, otpDailyCapReturning: 10 });
    for (let i = 0; i < 12; i++) await err(sendOtp(`+91985550${String(1000 + i)}`, `10.2.${i}.1`));
    expect(await err(sendOtp("+919855501999", "10.2.99.1"))).toBe("RATE_LIMITED"); // new pool is full
    await makeReturning("+919866600001");
    expect(await err(sendOtp("+919866600001", "10.2.100.1"))).toBe("OK"); // returning pool still open
    const usage = await otpCapUsage();
    expect(usage.returning.used).toBe(1);
    expect(usage.new.used).toBeGreaterThanOrEqual(10);
  });

  it("the owner's 'raise today's cap' adds to both pools for today only", async () => {
    await db.update(schema.settings).set({ otpDailyCapNew: 10, otpCapBoost: 5, otpCapBoostDate: istDateKey(NOW) });
    expect((await otpCapUsage()).new.cap).toBe(15);
    await db.update(schema.settings).set({ otpCapBoostDate: addDays(istDateKey(NOW), -1) });
    expect((await otpCapUsage()).new.cap).toBe(10);
  });
});

describe("SEC-35 trusted devices", () => {
  it("a device cookie verifies only its own phone, and is revoked by blocking", async () => {
    const phone = "+919877700001";
    await db.insert(schema.customers).values({ name: "Trusty", phone });
    const token = issueTrustToken(phone, 0);
    expect(await checkTrustToken(token, phone)).toBe(true);
    expect(await checkTrustToken(token, "+919877700002")).toBe(false); // phone A's cookie never verifies phone B
    expect(await checkTrustToken(token.slice(0, -2) + "00", phone)).toBe(false); // tampered
    await db.update(schema.customers).set({ trustEpoch: 1 }).where(eq(schema.customers.phone, phone)); // owner revoked
    expect(await checkTrustToken(token, phone)).toBe(false);
    const t2 = issueTrustToken(phone, 1);
    await db.update(schema.customers).set({ isBlocked: true }).where(eq(schema.customers.phone, phone));
    expect(await checkTrustToken(t2, phone)).toBe(false);
  });
});

describe("SEC-34/09 Turnstile + live startup", () => {
  it("siteverify must match our hostname and the otp_send action", () => {
    const ok = { success: true, hostname: "turf.example.in", action: "otp_send" };
    expect(checkSiteverify(ok, ["turf.example.in"])).toBe(true);
    expect(checkSiteverify({ ...ok, hostname: "evil.example" }, ["turf.example.in"])).toBe(false);
    expect(checkSiteverify({ ...ok, action: "login" }, ["turf.example.in"])).toBe(false);
    expect(checkSiteverify({ ...ok, success: false }, ["turf.example.in"])).toBe(false);
  });

  it("a live site won't start without Turnstile keys; 2FA off is warned", () => {
    const base = { NODE_ENV: "production", DEMO_MODE: "false", APP_SECRET: "x".repeat(40), CRON_SECRET: "y".repeat(20), DATABASE_URL: "postgres://x", PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b", RAZORPAY_WEBHOOK_SECRET: "c", OTP_PROVIDER: "whatsapp", NEXT_PUBLIC_SITE_URL: "https://turf.example.in" };
    expect(configProblems(base).join(" ")).toMatch(/TURNSTILE/);
    expect(configProblems({ ...base, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET_KEY: "s" })).toEqual([]);
    expect(configWarnings({ ...base, ADMIN_2FA_REQUIRED: "false" }).join(" ")).toMatch(/2FA/);
  });
});

describe("SEC-36 per-network limits from Settings", () => {
  it("reads the limit from Settings and shows a friendly message", async () => {
    expect(await err(enforceIpLimit("otp-send", "203.0.113.9", 2))).toBe("OK");
    expect(await err(enforceIpLimit("otp-send", "203.0.113.9", 2))).toBe("OK");
    await expect(enforceIpLimit("otp-send", "203.0.113.9", 2)).rejects.toThrow(NETWORK_LIMIT_MESSAGE);
    expect(NETWORK_LIMIT_MESSAGE).toMatch(/call us/);
    const logged = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "security.ip_limit"));
    expect(logged).toHaveLength(1);
    expect(logged[0].entityId).toBe("203.0.x.x"); // masked
    expect(maskIp("2401:4900:1c2a::1")).toBe("2401:4900:x");
  });

  it("sendOtp uses Settings.otpSendPerIpHour, and per-number limits still apply when the IP limit is high", async () => {
    await db.update(schema.settings).set({ otpSendPerIpHour: 1 });
    expect(await err(sendOtp("+919888800001", "198.51.100.1"))).toBe("OK");
    expect(await err(sendOtp("+919888800002", "198.51.100.1"))).toBe("RATE_LIMITED");
    await db.update(schema.settings).set({ otpSendPerIpHour: 10000 });
    for (let i = 0; i < 3; i++) await sendOtp("+919888800003", "198.51.100.2");
    expect(await err(sendOtp("+919888800003", "198.51.100.2"))).toBe("RATE_LIMITED"); // 3 per number per 15 min
  });
});

describe("SEC-37 shared availability limiter + cache", () => {
  it("the fixed-window limit holds across two separate limiter clients (two instances)", async () => {
    const a = new PgCounterStore();
    const b = new PgCounterStore();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await windowLimit("avail-test", 4, 60_000, NOW, i % 2 ? a : b));
    expect(results.filter(Boolean)).toHaveLength(4);
    const rows = await db.select().from(schema.counters);
    expect(rows.filter((r) => r.key.startsWith("avail-test"))).toHaveLength(1); // one row per window, not per request
  });

  it("cached availability is reused, then invalidated by a booking on that court/day", async () => {
    const before = availabilityComputeCount();
    await getCachedAvailability(cricketId, DATE);
    await getCachedAvailability(cricketId, DATE);
    expect(availabilityComputeCount() - before).toBe(1);
    await createOnlineHold({ courtId: cricketId, date: DATE, times: ["20:00"], name: "Cache Test", whatsappOptIn: false, idempotencyKey: "cache-1", phone: "+919899900001", deviceId: "dev-cache" });
    const fresh = await getCachedAvailability(cricketId, DATE);
    expect(availabilityComputeCount() - before).toBe(2);
    expect(fresh.slots.find((s) => s.time === "20:00")!.state).toBe("BOOKED");
  });
});

describe("SEC-38 admin passwords and staff", () => {
  const owner = async () => (await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "owner@demo.com")))[0];

  it("password rules: length, common list, not the email", () => {
    expect(passwordProblem("short", "a@b.com")).toMatch(/10/);
    expect(passwordProblem("password123", "a@b.com")).toMatch(/common/);
    expect(passwordProblem("owner@demo.com", "owner@demo.com")).toBeTruthy();
    expect(passwordProblem("Ground-Lights-2026!", "owner@demo.com")).toBeNull();
  });

  it("change password: wrong current rejected; success signs out other sessions and revokes trusted devices", async () => {
    const o = await owner();
    await db.insert(schema.adminSessions).values([
      { id: "keep-me", adminId: o.id, csrfToken: "c1", expiresAt: new Date(NOW.getTime() + 3_600_000) },
      { id: "other-1", adminId: o.id, csrfToken: "c2", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    ]);
    expect(await err(changePassword(o.id, "wrong-password", "Ground-Lights-2026!", "keep-me"))).toBe("VALIDATION");
    await changePassword(o.id, "Demo@1234", "Ground-Lights-2026!", "keep-me");
    const sessions = await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.adminId, o.id));
    expect(sessions.map((s) => s.id)).toEqual(["keep-me"]);
    const after = await owner();
    expect(await bcrypt.compare("Ground-Lights-2026!", after.passwordHash)).toBe(true);
    expect(after.trustEpoch).toBe(o.trustEpoch + 1);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "admin.password_change"))).toHaveLength(1);
  });

  it("forgot password: silent for unknown emails; code is single use, expires, and locks after 5 tries", async () => {
    await requestPasswordReset("nobody@example.com", "1.1.1.1"); // no error, nothing sent
    expect(await db.select().from(schema.adminCodes)).toHaveLength(0);

    const o = await owner();
    const { devCode } = await issueAdminCode(o, "RESET");
    await resetPasswordWithCode("owner@demo.com", devCode!, "Ground-Lights-2026!");
    expect(await err(resetPasswordWithCode("owner@demo.com", devCode!, "Another-Secret-99"))).toBe("OTP_INVALID"); // single use
    expect(await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.adminId, o.id))).toHaveLength(0); // all signed out

    const later = new Date(NOW.getTime() + 11 * 60_000);
    const c2 = await issueAdminCode(o, "RESET", {}, NOW);
    expect(await err(verifyAdminCode({ adminId: o.id }, "RESET", c2.devCode!, later))).toBe("OTP_INVALID"); // expired

    const c3 = await issueAdminCode(o, "RESET");
    const wrong = c3.devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await err(verifyAdminCode({ adminId: o.id }, "RESET", wrong));
    expect(await err(verifyAdminCode({ adminId: o.id }, "RESET", c3.devCode!))).toBe("OTP_LOCKED");
  });

  it("owner creates staff (must change password), resets and disables them", async () => {
    const u = await createStaff({ email: "new.staff@example.com", name: "New Staff", phone: "+919811100099", tempPassword: "Temp-Pass-12345" }, "owner@demo.com");
    expect(u.mustChangePassword).toBe(true);
    await db.insert(schema.adminSessions).values({ id: "staff-s", adminId: u.id, csrfToken: "c", expiresAt: new Date(NOW.getTime() + 3_600_000) });
    await manageStaff(u.id, { type: "disable" }, "owner@demo.com");
    const [d] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, u.id));
    expect(d.isActive).toBe(false);
    expect(await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.adminId, u.id))).toHaveLength(0);
    const o = await owner();
    expect(await err(manageStaff(o.id, { type: "disable" }, "x"))).toBe("NOT_FOUND"); // owner accounts can't be managed here
  });
});

describe("SEC-39 two-factor codes", () => {
  it("a login code for admin A can't log in admin B; codes are single use", async () => {
    const [owner] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "owner@demo.com"));
    const [staff] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "staff@demo.com"));
    const a = await issueAdminCode(owner, "LOGIN");
    const b = await issueAdminCode(staff, "LOGIN");
    expect(await err(verifyAdminCode({ challengeId: b.challengeId }, "LOGIN", a.devCode!))).toBe(a.devCode === b.devCode ? "OK" : "OTP_INVALID");
    const r = await verifyAdminCode({ challengeId: a.challengeId }, "LOGIN", a.devCode!);
    expect(r.admin.id).toBe(owner.id);
    expect(await err(verifyAdminCode({ challengeId: a.challengeId }, "LOGIN", a.devCode!))).toBe("OTP_INVALID");
  });

  it("admin login codes don't touch the customer OTP caps", async () => {
    const [owner] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "owner@demo.com"));
    await issueAdminCode(owner, "LOGIN");
    const usage = await otpCapUsage();
    expect(usage.new.used + usage.returning.used).toBe(0);
  });
});

describe("SEC-40 one cancellation policy", () => {
  const p = { cancelCutoffHours: 1, refundCutoffHours: 5, refundPercentBeforeCutoff: 100, refundPercentAfterCutoff: 25 };

  it("all wording comes from Settings", () => {
    expect(policyLines(p).join(" ")).toMatch(/5 hours or more.*full refund.*less than 5 hours.*25% of the advance.*closes 1 hour/);
    expect(policySummary(p)).toMatch(/5 hours or more.*25%/);
    expect(cancelledRefundText({ ...p, refundPercentAfterCutoff: 0 }, 0, "₹0")).toMatch(/less than 5 hours/);
    const msg = renderTemplate("booking_confirmed", { name: "A", sport: "s", court: "c", date: "d", time: "t", code: "C", advance: "₹1", balance: "₹2", map: "m", policy: policySummary(p) });
    expect(msg).toContain(policySummary(p));
    expect(refundFor(p, { startAt: new Date(NOW.getTime() + 3_600_000 * 3), now: NOW, paidAmount: 400 })).toBe(100);
  });

  it("no cutoff hours or refund percentages are hardcoded in the app's policy text", () => {
    const roots = ["app", "components", "config", "lib"].map((d) => path.join(process.cwd(), d));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p2 = path.join(dir, f);
        if (statSync(p2).isDirectory()) walk(p2);
        else if (/\.(tsx?|mjs)$/.test(f) && !p2.endsWith(path.join("lib", "policy.ts"))) files.push(p2);
      }
    };
    roots.forEach(walk);
    const hourNearPolicy = /(\d+\s*(?:hours?|hrs?)\b[^"`'\n]{0,40}\b(?:cancel|refund))|((?:cancel|refund)\w*[^"`'\n]{0,40}\b\d+\s*(?:hours?|hrs?)\b)/i;
    const pctNearRefund = /\b\d{1,3}\s*%[^"`'\n]{0,30}refund|refund[^"`'\n]{0,30}\b\d{1,3}\s*%/i;
    const offenders = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && (hourNearPolicy.test(line) || pctNearRefund.test(line))),
    );
    expect(offenders.map((o) => `${path.relative(process.cwd(), o.f)}:${o.i}: ${o.line.trim()}`)).toEqual([]);
  });
});

void vi;
void and;
