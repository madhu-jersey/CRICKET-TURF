/**
 * P2 hardening: SEC-52 missing migrations stop a live start · SEC-53 owner account tools ·
 * SEC-54 money alerts · SEC-55 error reporting + health check · SEC-56 crons on any scheduler.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { readdirSync } from "node:fs";
import { setDbOverride, schema, type DB } from "@/db/client";
import { createTestDb, type TestDb } from "../support/test-db";
import { seedDatabase } from "@/db/seed";
import { addDays, istDateKey } from "@/lib/time";
import { flushBackground } from "@/lib/background";
import { getPaymentProvider, webhookSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import { createOnlineHold, handlePaymentWebhook, sendReminders, BAD_WEBHOOK_ALERT_AFTER } from "@/lib/booking/service";
import { getBookingByCode, listCourts } from "@/lib/booking/data";
import { MIGRATIONS, missingMigrations } from "@/db/migration-list";
import { migrationProblems, runStartupChecks, configWarnings } from "@/lib/startup-checks";
import { createOwner, recoverAdmin, removeDemoAdmins, ToolError } from "@/lib/admin/tools";
import { buildEvent, reportError, scrub } from "@/lib/error-report";
import { GET as health } from "@/app/api/health/route";

let t: TestDb;
let db: DB;
let cricketId: string;
let webhookSecret = "";
const NOW = new Date();
const DATE = addDays(istDateKey(NOW), 6);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setDbOverride(db);
});
afterAll(async () => {
  await flushBackground();
  await t?.close();
  setDbOverride(undefined);
});

const alerts = async (text: string) => {
  await flushBackground();
  return db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.template, "admin_alert"), like(schema.messageLogs.renderedText, `%${text}%`)));
};
const LIVE_ENV = {
  NODE_ENV: "production",
  DEMO_MODE: "false",
  APP_SECRET: "x".repeat(40),
  CRON_SECRET: "y".repeat(20),
  DATABASE_URL: "postgres://user:pass@db.example.test/app",
  PAYMENT_PROVIDER: "razorpay",
  RAZORPAY_KEY_ID: "rzp_test_x",
  RAZORPAY_KEY_SECRET: "s",
  RAZORPAY_WEBHOOK_SECRET: "w",
  OTP_PROVIDER: "whatsapp",
  NEXT_PUBLIC_SITE_URL: "https://staging.example.test",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k",
  TURNSTILE_SECRET_KEY: "s",
};

describe("SEC-52 a live server won't start with missing migrations", () => {
  it("the expected list matches db/migrations exactly", () => {
    const files = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect([...MIGRATIONS]).toEqual(files);
    expect(missingMigrations(MIGRATIONS)).toEqual([]);
    expect(missingMigrations(["0001_init.sql"])).toEqual(MIGRATIONS.slice(1));
  });

  it("a missing migration is named and the server exits", async () => {
    expect(await migrationProblems()).toEqual([]);
    await db.execute(sql`delete from "_migrations" where "name" = ${"0009_refund_reconcile.sql"}`);
    const problems = await migrationProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0009_refund_reconcile.sql");
    expect(problems[0]).toContain("npm run deploy:migrate");

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runStartupChecks(LIVE_ENV)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join(" ")).toContain("0009_refund_reconcile.sql");
  });
});

describe("SEC-53 owner account tools", () => {
  it("admin:create refuses while an active owner exists (unless --force), applies the password rules, and creates an OWNER", async () => {
    const input = { email: "Real.Owner@Venue.test", name: "Real Owner", phone: "98123 45678", password: "Floodlit-Turf-2026" };
    await expect(createOwner(input)).rejects.toThrow(/active owner already exists/);
    await expect(createOwner({ ...input, password: "password123", force: true })).rejects.toThrow(ToolError);
    await expect(createOwner({ ...input, phone: "12345", force: true })).rejects.toThrow(/Indian mobile/);
    const u = await createOwner({ ...input, force: true });
    const [row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, u.id));
    expect(row).toMatchObject({ email: "real.owner@venue.test", role: "OWNER", phone: "+919812345678", isActive: true, mustChangePassword: false });
    expect(await bcrypt.compare("Floodlit-Turf-2026", row.passwordHash)).toBe(true);
    await expect(createOwner({ ...input, force: true })).rejects.toThrow(/already exists/);
  });

  it("admin:remove-demo deactivates both demo accounts and signs them out", async () => {
    const demo = await db.select().from(schema.adminUsers).where(inArray(schema.adminUsers.email, ["owner@demo.com", "staff@demo.com"]));
    await db.insert(schema.adminSessions).values(demo.map((d, i) => ({ id: `demo-s-${i}`, adminId: d.id, csrfToken: "c", expiresAt: new Date(NOW.getTime() + 3_600_000) })));
    expect((await removeDemoAdmins()).sort()).toEqual(["owner@demo.com", "staff@demo.com"]);
    const after = await db.select().from(schema.adminUsers).where(inArray(schema.adminUsers.email, ["owner@demo.com", "staff@demo.com"]));
    expect(after.every((a) => !a.isActive)).toBe(true);
    expect(await db.select().from(schema.adminSessions)).toHaveLength(0);
    expect(await removeDemoAdmins()).toEqual([]);
  });

  it("admin:recover sets a temporary password, forces a change, signs out everything, deletes recovery codes, audits", async () => {
    const [o] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, "owner@demo.com"));
    await db.insert(schema.adminSessions).values({ id: "owner-s", adminId: o.id, csrfToken: "c", expiresAt: new Date(NOW.getTime() + 3_600_000) });
    await db.insert(schema.adminRecoveryCodes).values({ adminId: o.id, codeHash: "h1" });
    const r = await recoverAdmin({ email: "OWNER@demo.com", phone: "+919811122233" });
    const [after] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, o.id));
    expect(await bcrypt.compare(r.temporaryPassword, after.passwordHash)).toBe(true);
    expect(after).toMatchObject({ mustChangePassword: true, trustEpoch: o.trustEpoch + 1, phone: "+919811122233", recoveryCodesAt: null });
    expect(await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.adminId, o.id))).toHaveLength(0);
    expect(await db.select().from(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, o.id))).toHaveLength(0);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "admin.recover"))).toHaveLength(1);
    await expect(recoverAdmin({ email: "nobody@venue.test" })).rejects.toThrow(/No admin account/);
  });
});

describe("SEC-54 money alerts", () => {
  async function hold(time: string) {
    return createOnlineHold({ courtId: cricketId, date: DATE, times: [time], name: "Alert Test", whatsappOptIn: false, idempotencyKey: `p2-${++n}`, phone: `+9198765${String(54000 + n)}`, deviceId: `dev-p2-${n}` });
  }
  const send = (body: string, sig: string, id: string) => handlePaymentWebhook(body, sig, id).catch((e: { code?: string }) => e.code);

  it("an amount mismatch alerts the owner every time, and doesn't confirm the booking", async () => {
    const h = await hold("08:00");
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_mm_1", order_id: h.order!.orderId, amount: 100 } } } });
    await send(body, webhookSignature(body, webhookSecret), "evt_mm_1");
    expect(await alerts("amount mismatch")).toHaveLength(1);
    expect((await getBookingByCode(h.bookingCode))!.booking.status).toBe("PENDING_PAYMENT");
    await send(body, webhookSignature(body, webhookSecret), "evt_mm_1"); // same event again: deduplicated
    expect(await alerts("amount mismatch")).toHaveLength(1);
  });

  it(`more than ${BAD_WEBHOOK_ALERT_AFTER} bad webhook signatures in an hour → exactly one alert`, async () => {
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    for (let i = 0; i < 9; i++) expect(await send(body, "bad-signature", `evt_bad_${i}`)).toBe("INVALID_SIGNATURE");
    expect(await alerts("bad signature")).toHaveLength(1);
  });

  it(`${BAD_WEBHOOK_ALERT_AFTER} or fewer bad signatures → no alert`, async () => {
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    for (let i = 0; i < BAD_WEBHOOK_ALERT_AFTER; i++) await send(body, "bad", `evt_ok_${i}`);
    expect(await alerts("bad signature")).toHaveLength(0);
  });
});

describe("SEC-55 error reporting and health check", () => {
  it("scrubs phones and e-mails, and sends nothing without SENTRY_DSN", async () => {
    expect(scrub("Customer +91 98123 45678 / 9812345678 / a.b@c.in failed")).toBe("Customer [phone] / [phone] / [email] failed");
    const ev = buildEvent(new Error("refund for +919812345678 failed"), { method: "POST", path: "/api/bookings/BBA-ABCD1234/cancel?x=secret" });
    expect(ev.exception.values[0].value).toBe("refund for [phone] failed");
    expect(ev.tags.path).toBe("/api/bookings/BBA-ABCD1234/cancel");
    expect(JSON.stringify(ev)).not.toMatch(/cookie|body|headers|secret/i);

    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    reportError(new Error("x"));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("SENTRY_DSN", "https://publickey123@o1.ingest.sentry.io/4242");
    reportError(new Error("boom for 9812345678"), { method: "GET", path: "/book" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.sentry.io/api/4242/envelope/");
    expect(String((init.headers as Record<string, string>)["X-Sentry-Auth"])).toContain("sentry_key=publickey123");
    expect(String(init.body)).toContain("boom for [phone]");
    expect(String(init.body)).not.toContain("9812345678");
  });

  it("warns at startup on a live site without SENTRY_DSN", () => {
    expect(configWarnings(LIVE_ENV).join(" ")).toMatch(/SENTRY_DSN/);
    expect(configWarnings({ ...LIVE_ENV, SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" }).join(" ")).not.toMatch(/SENTRY_DSN/);
  });

  it("/api/health: 200 when the database answers, 503 when it hangs or fails", async () => {
    const ok = await health();
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");

    setDbOverride({ execute: () => new Promise(() => {}) } as unknown as DB);
    const started = Date.now();
    const hung = await health();
    expect(hung.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(3_000);

    setDbOverride({ execute: async () => Promise.reject(new Error("ECONNREFUSED")) } as unknown as DB);
    const down = await health();
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("unavailable");
  });
});

describe("SEC-56 crons work with any scheduler (hourly, late)", () => {
  it("a reminder still goes out when the cron runs late (90 minutes before start), once", async () => {
    const courts = await listCourts(db);
    const court = courts.find((c) => c.name === "Pickleball Court 2")!;
    // Clear the court so a booking can sit at an arbitrary time without overlapping demo data.
    await db.update(schema.bookings).set({ status: "CANCELLED" }).where(eq(schema.bookings.courtId, court.id));
    const [c] = await db.select().from(schema.customers).limit(1);
    await db.update(schema.customers).set({ whatsappOptIn: true }).where(eq(schema.customers.id, c.id));
    const start = new Date(NOW.getTime() + 90 * 60_000);
    const [b] = await db
      .insert(schema.bookings)
      .values({ bookingCode: "BBA-LATECRN1", customerId: c.id, courtId: court.id, startAt: start, endAt: new Date(start.getTime() + 3_600_000), status: "CONFIRMED", totalAmount: 600, advanceAmount: 300, balanceAmount: 300, source: "ONLINE" })
      .returning();
    expect(await sendReminders(NOW)).toBeGreaterThanOrEqual(1);
    expect(await sendReminders(new Date(NOW.getTime() + 60 * 60_000))).toBe(0); // next hourly run: already sent
    await flushBackground();
    const sent = await db.select().from(schema.messageLogs).where(and(eq(schema.messageLogs.bookingId, b.id), eq(schema.messageLogs.template, "booking_reminder")));
    expect(sent).toHaveLength(1);
  });
});
