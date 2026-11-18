/**
 * HTTP-level security regression tests against the isolated e2e server (mock providers, demo data).
 * Runs once (desktop project) — these are API checks, not UI.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "API checks run once");

const BASE = "http://localhost:3100";
const CRON = "e2e-cron-secret-0123456789";

async function csrfOf(ctx: APIRequestContext) {
  const st = await ctx.storageState();
  return st.cookies.find((c) => c.name === "bba_csrf")?.value ?? "";
}
// One login per account per run: admin login is rate limited (5 per account per 15 min, SEC-13),
// so tests share sessions instead of logging in repeatedly.
const sessions = new Map<string, Promise<APIRequestContext>>();
function adminCtx(email: string) {
  if (!sessions.has(email)) {
    sessions.set(
      email,
      (async () => {
        const ctx = await pwRequest.newContext({ baseURL: BASE });
        await loginWith2fa(ctx, email, "Demo@1234");
        return ctx;
      })(),
    );
  }
  return sessions.get(email)!;
}
/** Password step + (when required) the 2FA code step. Returns the login response JSON. */
async function loginWith2fa(ctx: APIRequestContext, email: string, password: string, trustDevice = false) {
  const r = await ctx.post("/api/admin/login", { data: { email, password, trustDevice } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  if (!j.twoFactor) return j;
  const v = await ctx.post("/api/admin/login/verify", { data: { challengeId: j.challengeId, code: j.devCode } });
  expect(v.status()).toBe(200);
  return { ...j, verified: await v.json() };
}
let phoneSeq = 0;
/** Verifies a phone via the mock OTP (the demo returns the code) and returns a context holding the cookie. */
async function verifiedCtx() {
  const phone = `95${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(2, "0")}`;
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  await ctx.get("/api/session/phone"); // device cookie
  const s = await ctx.post("/api/otp/send", { data: { phone } });
  expect(s.status()).toBe(200);
  const { devCode } = await s.json();
  const v = await ctx.post("/api/otp/verify", { data: { phone, code: devCode } });
  expect(v.status()).toBe(200);
  return { ctx, phone: `+91${phone}` };
}
async function courts(ctx: APIRequestContext) {
  const html = await (await ctx.get("/book?sport=cricket")).text();
  return html;
}
function istDate(days: number) {
  return new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
}
async function freeSlot(ctx: APIRequestContext, courtId: string, date: string) {
  const r = await (await ctx.get(`/api/availability?courtId=${courtId}&date=${date}`)).json();
  return (r.slots as { time: string; state: string; price: number }[]).find((s) => s.state === "AVAILABLE")!;
}
async function cricketCourtId(ctx: APIRequestContext) {
  // Owner-only listing isn't public; read the court id from the public booking page links.
  const admin = await adminCtx("owner@demo.com");
  const html = await (await admin.get("/admin/walk-in")).text();
  const m = /<option value="([0-9a-f-]{36})"[^>]*>Box Cricket Arena</.exec(html);
  void ctx;
  return m![1];
}

test("SEC-21 security headers are present", async ({ request }) => {
  const r = await request.get(`${BASE}/`);
  const h = r.headers();
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("object-src 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-powered-by"]).toBeUndefined();
  const a = await request.get(`${BASE}/admin/login`);
  expect(a.headers()["x-robots-tag"]).toContain("noindex");
  expect(await (await request.get(`${BASE}/robots.txt`)).text()).toContain("Disallow: /admin");
});

const ADMIN_ROUTES: { method: "get" | "post" | "put" | "patch" | "delete"; path: string; owner: boolean; data?: object }[] = [
  { method: "get", path: "/api/admin/availability?courtId=x&date=2026-01-01", owner: false },
  { method: "get", path: "/api/admin/bookings/00000000-0000-0000-0000-000000000000", owner: false },
  { method: "post", path: "/api/admin/bookings/00000000-0000-0000-0000-000000000000", owner: false, data: { action: "complete" } },
  { method: "post", path: "/api/admin/walk-in", owner: false, data: {} },
  { method: "get", path: "/api/admin/bookings/export", owner: true },
  { method: "post", path: "/api/admin/blocks", owner: true, data: {} },
  { method: "delete", path: "/api/admin/blocks?id=x", owner: true },
  { method: "patch", path: "/api/admin/courts", owner: true, data: {} },
  { method: "patch", path: "/api/admin/customers", owner: true, data: {} },
  { method: "put", path: "/api/admin/gallery", owner: true, data: { ids: [] } },
  { method: "patch", path: "/api/admin/gallery", owner: true, data: {} },
  { method: "delete", path: "/api/admin/gallery?id=x", owner: true },
  { method: "post", path: "/api/admin/holidays", owner: true, data: {} },
  { method: "delete", path: "/api/admin/holidays?id=x", owner: true },
  { method: "post", path: "/api/admin/messages/x/retry", owner: true },
  { method: "put", path: "/api/admin/pricing", owner: true, data: {} },
  { method: "put", path: "/api/admin/settings", owner: true, data: {} },
  { method: "post", path: "/api/admin/users", owner: true, data: {} },
  { method: "patch", path: "/api/admin/users", owner: true, data: {} },
  { method: "post", path: "/api/admin/otp-cap", owner: true, data: { amount: 10 } },
];

test("SEC-14 every admin route: 401 without a session, 403 for STAFF on owner routes, 403 without CSRF", async () => {
  const anon = await pwRequest.newContext({ baseURL: BASE });
  for (const r of ADMIN_ROUTES) {
    const res = await anon[r.method](r.path, { data: r.data });
    expect(res.status(), `${r.method} ${r.path} anonymous`).toBe(401);
  }
  const staff = await adminCtx("staff@demo.com");
  const staffCsrf = await csrfOf(staff);
  for (const r of ADMIN_ROUTES.filter((x) => x.owner)) {
    const res = await staff[r.method](r.path, { data: r.data, headers: { "x-csrf-token": staffCsrf } });
    expect(res.status(), `${r.method} ${r.path} as staff`).toBe(403);
  }
  // Staff can't cancel with a refund.
  const refund = await staff.post("/api/admin/bookings/00000000-0000-0000-0000-000000000000", { data: { action: "cancel", refundMode: "FULL" }, headers: { "x-csrf-token": staffCsrf } });
  expect(refund.status()).toBe(403);
  const owner = await adminCtx("owner@demo.com");
  for (const r of ADMIN_ROUTES.filter((x) => x.method !== "get")) {
    const res = await owner[r.method](r.path, { data: r.data }); // no CSRF header
    expect(res.status(), `${r.method} ${r.path} without CSRF`).toBe(403);
  }
  const forged = await owner.put("/api/admin/settings", { data: {}, headers: { "x-csrf-token": "wrong" } });
  expect(forged.status()).toBe(403);
  await anon.dispose();
});

test("SEC-24 cron endpoints need the secret", async ({ request }) => {
  for (const path of ["/api/cron/expire-holds", "/api/cron/send-reminders"]) {
    expect((await request.get(`${BASE}${path}`)).status()).toBe(401);
    expect((await request.get(`${BASE}${path}`, { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
    expect((await request.get(`${BASE}${path}`, { headers: { authorization: `Bearer ${CRON}` } })).status()).toBe(200);
  }
});

test("SEC-25 payments: fake verify and forged/unsigned webhooks are rejected", async ({ request }) => {
  const fake = await request.post(`${BASE}/api/payments/verify`, { data: { orderId: "order_fake", paymentId: "pay_fake", signature: "0".repeat(64) } });
  expect(fake.status()).toBe(400);
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_x", amount: 30000 } } } });
  expect((await request.post(`${BASE}/api/webhooks/razorpay`, { data: body, headers: { "content-type": "application/json" } })).status()).toBe(400);
  expect((await request.post(`${BASE}/api/webhooks/razorpay`, { data: body, headers: { "content-type": "application/json", "x-razorpay-signature": "deadbeef" } })).status()).toBe(400);
});

test("SEC-26 booking without a verified phone is rejected; tampered fields are ignored", async () => {
  const anon = await pwRequest.newContext({ baseURL: BASE });
  const courtId = await cricketCourtId(anon);
  const date = istDate(8);
  const slot = await freeSlot(anon, courtId, date);
  const payload = { courtId, date, times: [slot.time], name: "Tamper Test", whatsappOptIn: false, acceptTerms: true, idempotencyKey: `tamper-${Date.now()}` };
  expect((await anon.post("/api/bookings", { data: payload })).status()).toBe(401);

  const { ctx } = await verifiedCtx();
  const r = await ctx.post("/api/bookings", { data: { ...payload, status: "CONFIRMED", totalAmount: 1, advanceAmount: 0, source: "WALK_IN", discountAmount: 9999 } });
  expect(r.status()).toBe(201);
  const hold = await r.json();
  expect(hold.status).toBe("PENDING_PAYMENT");
  expect(hold.subtotal).toBe(slot.price);
  expect(hold.advance).toBe(300);
  await Promise.all([anon.dispose(), ctx.dispose()]);
});

test("SEC-27 a verified token for phone A can't view or cancel phone B's booking", async () => {
  const a = await verifiedCtx();
  const b = await verifiedCtx();
  const courtId = await cricketCourtId(a.ctx);
  const date = istDate(9);
  const slot = await freeSlot(b.ctx, courtId, date);
  const hb = await (await b.ctx.post("/api/bookings", { data: { courtId, date, times: [slot.time], name: "Bee Owner", whatsappOptIn: false, acceptTerms: true, idempotencyKey: `b-${Date.now()}` } })).json();
  const cancel = await a.ctx.post(`/api/bookings/${hb.bookingCode}/cancel`);
  expect(cancel.status()).toBe(403);
  const mine = await (await a.ctx.get("/api/my-bookings")).json();
  expect(JSON.stringify(mine)).not.toContain(hb.bookingCode);
  // The public booking page shows only a first name and a masked phone.
  const page = await (await a.ctx.get(`/booking/${hb.bookingCode}`)).text();
  expect(page).not.toContain(b.phone);
  expect(page).not.toContain("Bee Owner");
  const pay = await (await a.ctx.post(`/api/bookings/${hb.bookingCode}/pay`)).json();
  expect(pay.prefill.phone).toBe("");
  await Promise.all([a.ctx.dispose(), b.ctx.dispose()]);
});

test("SEC-22 XSS payloads render as text in admin views and the CSV export", async ({ page }) => {
  const owner = await adminCtx("owner@demo.com");
  const csrf = await csrfOf(owner);
  const courtId = await cricketCourtId(owner);
  const date = istDate(11);
  const slot = await freeSlot(owner, courtId, date);
  const evil = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
  const w = await owner.post("/api/admin/walk-in", {
    // Name is capped at 50 chars and has < > stripped on input; notes keep the raw payload so the
    // output-escaping path is exercised too.
    data: { courtId, date, times: [slot.time], name: `=HYPERLINK("x")"><img src=x onerror=1>`, phone: "9123400011", source: "PHONE", amountReceived: 0, paymentMode: "CASH", notes: evil },
    headers: { "x-csrf-token": csrf },
  });
  expect(w.status()).toBe(201);
  const csv = await (await owner.get("/api/admin/bookings/export", { headers: { "x-csrf-token": csrf } })).text();
  expect(csv).toContain(`"'=HYPERLINK(""x"")`);
  expect(csv).not.toMatch(/<script>/i);

  await page.context().addCookies((await owner.storageState()).cookies);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await page.goto(`${BASE}/admin/bookings?q=HYPERLINK`);
  await page.getByRole("button", { name: "Manage" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(dialogs).toBe(0);
  expect(await page.locator("img[src='x']").count()).toBe(0);
});

test("SEC-19 oversized request bodies are rejected", async ({ request }) => {
  const r = await request.post(`${BASE}/api/otp/send`, { data: { phone: "9876543210", pad: "a".repeat(50_000) } });
  expect(r.status()).toBe(400);
});

void courts;

test("SEC-39 2FA: no session without the code; trusted device skips it; a password change revokes trust", async () => {
  // A fresh staff account so the shared demo logins aren't affected.
  const owner = await adminCtx("owner@demo.com");
  const email = `twofa.${Date.now()}@example.com`;
  const created = await owner.post("/api/admin/users", {
    data: { email, name: "Two Factor", phone: "9811100055", tempPassword: "Temp-Pass-12345" },
    headers: { "x-csrf-token": await csrfOf(owner) },
  });
  expect(created.status()).toBe(201);

  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const step1 = await (await ctx.post("/api/admin/login", { data: { email, password: "Temp-Pass-12345", trustDevice: true } })).json();
  expect(step1.twoFactor).toBe(true);
  expect((await ctx.get("/api/admin/availability?courtId=x&date=2026-01-01")).status()).toBe(401); // no session yet
  expect((await ctx.post("/api/admin/login/verify", { data: { challengeId: step1.challengeId, code: step1.devCode === "000000" ? "111111" : "000000" } })).status()).toBe(400);
  const ok = await ctx.post("/api/admin/login/verify", { data: { challengeId: step1.challengeId, code: step1.devCode } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).mustChangePassword).toBe(true);
  // Forced change: other admin APIs refuse until the password is changed.
  expect((await ctx.get("/api/admin/availability?courtId=x&date=2026-01-01")).status()).toBe(403);
  const csrf = await csrfOf(ctx);
  expect((await ctx.put("/api/admin/password", { data: { currentPassword: "wrong-password", newPassword: "Night-Match-2026!" }, headers: { "x-csrf-token": csrf } })).status()).toBe(400);

  // Trusted device: logging in again from this context skips the code.
  const again = await (await ctx.post("/api/admin/login", { data: { email, password: "Temp-Pass-12345" } })).json();
  expect(again.twoFactor).toBeUndefined();

  // Changing the password revokes device trust → the next login needs a code again.
  const csrf2 = await csrfOf(ctx);
  expect((await ctx.put("/api/admin/password", { data: { currentPassword: "Temp-Pass-12345", newPassword: "Night-Match-2026!" }, headers: { "x-csrf-token": csrf2 } })).status()).toBe(200);
  const after = await (await ctx.post("/api/admin/login", { data: { email, password: "Night-Match-2026!" } })).json();
  expect(after.twoFactor).toBe(true);
  await ctx.dispose();
});

test("SEC-38 forgot password gives the same answer for real and unknown accounts", async ({ request }) => {
  const a = await (await request.post(`${BASE}/api/admin/password`, { data: { email: "nobody-here@example.com" } })).json();
  const b = await (await request.post(`${BASE}/api/admin/password`, { data: { email: "staff@demo.com" } })).json();
  expect(a).toEqual(b);
  expect(a.message).toMatch(/If this account exists/);
});

test("SEC-40 changing the policy settings changes every page that shows it", async () => {
  const owner = await adminCtx("owner@demo.com");
  const csrf = await csrfOf(owner);
  const base = {
    advanceType: "FIXED", advanceValue: "300", holdMinutes: "10", maxDaysAhead: "14", newCustomerDiscountPercent: "10",
    cancelCutoffHours: "0", refundCutoffHours: "2", refundPercentBeforeCutoff: "100", refundPercentAfterCutoff: "0",
    maxActiveBookingsPerPhone: "2", maxBookingsPerPhonePerDay: "4", noShowBlockThreshold: "3",
    otpDailyCapNew: "200", otpDailyCapReturning: "300", otpSendPerIpHour: "30", otpVerifyPerIpHour: "60", bookingPerIpHour: "60", cancelPerIpHour: "30",
    ownerAlertPhone: "9000000000", businessName: "Boundary Box Arena", address: "Near Bypass Road, Bhimavaram, Andhra Pradesh 534201",
    mapLink: "https://maps.google.com/?q=16.5449,81.5212", phone: "9000000000",
  };
  const put = (data: object) => owner.put("/api/admin/settings", { data, headers: { "x-csrf-token": csrf } });
  expect((await put({ ...base, refundCutoffHours: "5", refundPercentAfterCutoff: "25" })).status()).toBe(200);
  try {
    const policy = await (await owner.get("/refund-policy")).text();
    expect(policy).toContain("5 hours or more");
    expect(policy).toContain("25% of the advance back");
    const book = await (await owner.get("/book?sport=cricket")).text();
    expect(book).toContain("Cancel 5 hours or more before your slot");
    const home = await (await owner.get("/")).text();
    expect(home).toContain("Cancel 5 hours or more before your slot");
    // Booking status page (a confirmed future booking).
    const courtId = await cricketCourtId(owner);
    const date = istDate(12);
    const slot = await freeSlot(owner, courtId, date);
    const w = await (await owner.post("/api/admin/walk-in", { data: { courtId, date, times: [slot.time], name: "Policy Check", phone: "9123400077", source: "PHONE", amountReceived: 0, paymentMode: "CASH" }, headers: { "x-csrf-token": csrf } })).json();
    const status = await (await owner.get(`/booking/${w.bookingCode}`)).text();
    expect(status).toContain("Cancel 5 hours or more before your slot");
  } finally {
    expect((await put(base)).status()).toBe(200);
  }
});
