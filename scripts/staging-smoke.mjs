// Read-only smoke checks for a STAGING deployment. See scripts/staging-smoke.md.
// Usage (PowerShell):  $env:STAGING_URL = "https://staging.example.com"; node scripts/staging-smoke.mjs
// Sends only GETs and unauthenticated POSTs that the server must refuse. Never creates bookings or sends OTPs.
const raw = process.env.STAGING_URL;
if (!raw) {
  console.error("Set STAGING_URL to the staging site, e.g. https://staging.example.com");
  process.exit(2);
}
const base = new URL(raw);
const host = base.hostname;
const looksSafe =
  ["localhost", "127.0.0.1", "::1"].includes(host) ||
  host.endsWith(".localhost") ||
  host.split(".").some((label) => /^(staging|stage|dev|test|qa|preview|sandbox)(-|$)/.test(label));
if (!looksSafe && process.env.STAGING_SMOKE_I_KNOW !== host) {
  console.error(`Refusing: "${host}" does not look like a staging host. If it really is staging, set STAGING_SMOKE_I_KNOW=${host}.`);
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, `${name} — ${e.message}`]);
  }
}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
const url = (p) => new URL(p, base).toString();
const get = (p, init) => fetch(url(p), { redirect: "manual", ...init });
const post = (p, body, headers = {}) =>
  fetch(url(p), { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

await check("home page loads (200) and has no demo banner", async () => {
  const r = await get("/");
  must(r.status === 200, `status ${r.status}`);
  const html = await r.text();
  must(!html.includes("payments and messages are simulated"), "demo banner is showing — DEMO_MODE is not false");
});

await check("security headers present", async () => {
  const r = await get("/");
  const h = (k) => r.headers.get(k) ?? "";
  must(h("content-security-policy").includes("frame-ancestors 'none'"), "CSP missing frame-ancestors 'none'");
  must(/nonce-/.test(h("content-security-policy")), "CSP has no script nonce");
  must(h("x-content-type-options") === "nosniff", "X-Content-Type-Options missing");
  must(h("referrer-policy") !== "", "Referrer-Policy missing");
  if (base.protocol === "https:") must(/max-age=\d{7,}/.test(h("strict-transport-security")), "HSTS missing or short");
});

await check("refund policy page shows the policy", async () => {
  const r = await get("/refund-policy");
  must(r.status === 200, `status ${r.status}`);
  must((await r.text()).includes("policy-lines"), "policy section not found");
});

await check("admin APIs refuse requests without a session (401)", async () => {
  for (const p of ["/api/admin/settings", "/api/admin/customers", "/api/admin/bookings/export"]) {
    const r = await get(p);
    must(r.status === 401, `${p} returned ${r.status}`);
  }
});

await check("admin login does not log in with the demo password", async () => {
  const r = await post("/api/admin/login", { email: "owner@demo.com", password: "Demo@1234" });
  must(r.status === 401 || r.status === 429, `returned ${r.status}`);
});

await check("forgot password answers the same for unknown accounts", async () => {
  const r = await post("/api/admin/password", { email: `nobody-${Date.now()}@example.invalid` });
  must(r.status === 200, `status ${r.status}`);
  must(/If this account exists/.test((await r.json()).message ?? ""), "unexpected message");
});

await check("cron endpoints need the secret", async () => {
  for (const p of ["/api/cron/expire-holds", "/api/cron/send-reminders"]) {
    must((await get(p)).status === 401, `${p} open without secret`);
    must((await get(p, { headers: { authorization: "Bearer wrong" } })).status === 401, `${p} accepted a wrong secret`);
  }
});

await check("forged payment verify and unsigned webhook are rejected", async () => {
  const v = await post("/api/payments/verify", { orderId: "order_fake", paymentId: "pay_fake", signature: "0".repeat(64) });
  must(v.status === 400, `verify returned ${v.status}`);
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_x", amount: 30000 } } } });
  must((await post("/api/webhooks/razorpay", body)).status === 400, "unsigned webhook accepted");
  must((await post("/api/webhooks/razorpay", body, { "x-razorpay-signature": "deadbeef" })).status === 400, "forged webhook accepted");
});

await check("mock payment simulator is disabled", async () => {
  const r = await post("/api/payments/mock/simulate", { orderId: "order_fake", outcome: "success" });
  must(r.status === 404 || r.status === 403, `returned ${r.status}`);
});

await check("booking without a verified phone is refused", async () => {
  const r = await post("/api/bookings", { courtId: "x", date: "2030-01-01", times: ["10:00"], name: "Smoke", phone: "9000000000" });
  must(r.status === 401 || r.status === 403 || r.status === 400, `returned ${r.status}`);
});

// OTP sending is checked by hand (section 2 of staging-smoke.md): an automated send could message a real number.

for (const [ok, name] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
