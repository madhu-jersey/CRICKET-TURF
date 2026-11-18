# Security Report — Boundary Box Arena

**Scope:** full codebase review + testing of the Next.js turf booking site (box cricket + pickleball): public booking with phone OTP, ₹ advance payment (Razorpay / mock), WhatsApp messaging, owner/staff dashboard.
**Environment:** local only — embedded Postgres (PGlite, real Postgres 17 with the real migrations), mock OTP / WhatsApp / payment providers, isolated production build on `localhost:3100`. No production systems, real payment accounts or real phone numbers were used.
**Date:** 18 Nov 2026 · **Version tested:** `main` + the fixes in this report.

> Note: this site **keeps online advance payment** (owner decision), so the review covers both the "no payment" checklist (booking abuse, OTP flooding, access control) and the payment checks (fake/forged/replayed payments, refunds).

---

## 1. Summary

| Severity | Found | Fixed | Accepted risk | Needs owner action |
|---|---|---|---|---|
| Critical | 1 | 1 | – | – |
| High | 5 | 5 | – | – |
| Medium | 9 | 9 | – | 1 (turn on Turnstile) |
| Low | 8 | 6 | 2 | – |
| Info | – | – | 3 | 1 (Supabase RLS, if used) |

**Overall risk after fixes: Low.** Every Critical, High and Medium issue is fixed and covered by an automated test. The code is **safe to go live once the go-live checklist (§5) is done**. The new startup check refuses to run a live (`DEMO_MODE=false`) server until the critical items are set.

**Tests:** 91 unit + integration tests (Vitest, including 27 in `tests/security/abuse.test.ts`), 19 browser/HTTP tests (Playwright, including 8 in `tests/security/http.spec.ts`, desktop + mobile). All pass.

The most important findings were:
- **SEC-01 (Critical):** on a live site where `PAYMENT_PROVIDER` wasn't set, the demo "Simulate success" checkout still worked, so **anyone could book for free**.
- **SEC-02 (High):** in demo mode on a production server, a missing `APP_SECRET` fell back to a value printed in the source code. **Anyone could forge a verified-phone cookie** and book, view or cancel bookings as any customer.
- **SEC-06 / SEC-08 (High):** a fake `X-Forwarded-For` header bypassed every per-network limit, and there was no overall daily cap on OTP codes, so **one attacker could run up an unlimited WhatsApp/SMS bill**.

---

## 2. Attack surface

### Pages
| Route | Auth | Reads / writes |
|---|---|---|
| `/`, `/gallery`, `/book`, `/contact`, `/privacy`, `/terms`, `/refund-policy` | none | read settings, availability, gallery |
| `/booking/[code]` | none (code); owner-only actions need verified phone | read booking (first name + masked phone only); creates a payment order if the hold is live |
| `/my-bookings` | verified phone (cookie) | read own bookings |
| `/admin/login` | none | — |
| `/admin` (overview), `/admin/blocked`, `/pricing`, `/courts`, `/customers/*`, `/gallery`, `/messages`, `/settings`, `/audit` | admin session, **OWNER** | read/write config, customers, logs |
| `/admin/schedule`, `/admin/bookings`, `/admin/walk-in` | admin session, STAFF+ | bookings |

### API routes
| Method & path | Auth | Inputs | Effect |
|---|---|---|---|
| GET `/api/availability` | none · 90/min/IP | courtId, date | read slots |
| POST `/api/otp/send` | none · 3/number/15 min, 10/IP/h, daily cap, optional Turnstile | phone or bookingCode | sends OTP (costs money) |
| POST `/api/otp/verify` | none · 40/IP/h, 5 tries/code | phone/bookingCode, code | sets verified-phone cookie (30 min) |
| GET/DELETE `/api/session/phone` | cookie | — | read/clear verified phone; sets device-ID cookie |
| POST `/api/bookings` | **verified phone** · 30/IP/h + per-number limits | courtId, date, times, name, optIn, idempotencyKey | creates hold + payment order |
| POST `/api/bookings/[code]/pay` | none (code) · 40/IP/h | — | returns/creates payment order for a live hold |
| POST `/api/bookings/[code]/cancel` | **verified phone = booking owner** · 20/IP/h, 3/number/day | — | cancel + policy refund |
| GET `/api/my-bookings` | verified phone | — | own bookings |
| GET/POST `/api/my-bookings/whatsapp` | verified phone | optIn | WhatsApp opt-in/out |
| POST `/api/payments/verify` | checkout **HMAC signature** | orderId, paymentId, signature | confirms payment |
| POST `/api/payments/mock/simulate` | **dev / DEMO_MODE only** + mock provider | orderId, outcome | fires a signed mock webhook |
| POST `/api/webhooks/razorpay` | **X-Razorpay-Signature** on raw body | Razorpay event | confirm/fail payment (idempotent) |
| GET `/api/cron/expire-holds`, `/api/cron/send-reminders` | **CRON_SECRET** bearer | — | expire holds, reminders, retry messages |
| GET `/api/files/[id]` | none | uuid | serves re-encoded gallery images |
| POST/DELETE `/api/admin/login` | none (rate limited) | email, password | admin session |
| GET `/api/admin/availability`, GET/POST `/api/admin/bookings/[id]`, POST `/api/admin/walk-in` | admin STAFF+ · CSRF on writes | ids, actions | bookings (refunds OWNER-only) |
| GET `/api/admin/bookings/export` | **OWNER** | filters | CSV of customers (formula-escaped, max 5000 rows) |
| `/api/admin/blocks`, `/courts`, `/customers`, `/gallery`, `/holidays`, `/messages/[id]/retry`, `/pricing`, `/settings` | **OWNER** · CSRF on writes | Zod-validated bodies | config |

### Where the server trusts client data
Only: court id, date, start times, name, WhatsApp opt-in, idempotency key (all Zod-validated). **Price, discount, advance, status, source and refund amounts are always computed on the server**; extra fields are stripped by Zod (verified by SEC-26).

### Third-party calls (all server-side)
Razorpay Orders/Refunds API · WhatsApp Cloud API or BSP · MSG91 SMS · Cloudflare Turnstile siteverify (optional) · Supabase Storage REST (optional). Google Maps is an iframe embed only (no server fetch). **No server-side fetch of user-supplied URLs (no SSRF).**

### Secrets / env vars
`APP_SECRET`, `CRON_SECRET`, `DATABASE_URL`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `META_WA_TOKEN`, `BSP_API_KEY`, `MSG91_AUTH_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SECRET_KEY` — all read only in server modules (`import "server-only"`). The only `NEXT_PUBLIC_` vars are `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, both meant to be public. `RAZORPAY_KEY_ID` reaches the browser by design (Razorpay publishable key).

---

## 3. Findings

### SEC-01 — Free bookings via the demo checkout on a live site · **Critical** · Fixed
- **Where:** `lib/providers/payment.ts:118`, `app/api/payments/mock/simulate/route.ts:19`, `lib/env.ts:59`
- **Reproduce:** run in production with `DEMO_MODE=false` and no `PAYMENT_PROVIDER` → provider defaults to mock → `POST /api/payments/mock/simulate {orderId, outcome:"success"}` returns a valid signature → booking confirmed.
- **Impact:** anyone could confirm bookings without paying. (CVSS-style: network, no auth, low complexity, integrity high.)
- **Fix:** the mock provider and the simulate endpoint are refused unless running in dev or `DEMO_MODE=true` (double gate). The startup check also refuses `PAYMENT_PROVIDER≠razorpay` on a live site.
- **Test:** `abuse.test.ts › SEC-01/02 › mock payment provider and the simulate endpoint are refused`

### SEC-02 — Built-in fallback secret in production demo mode · **High** · Fixed
- **Where:** `lib/env.ts:18`
- **Reproduce:** `NODE_ENV=production DEMO_MODE=true`, no `APP_SECRET` → tokens are signed with the string in the repo → forge `bba_vp` for any phone.
- **Impact:** an attacker could book, view or cancel any customer's bookings, and forge mock-payment signatures.
- **Fix:** `APP_SECRET` (≥ 32 chars) is mandatory whenever `NODE_ENV=production`, demo or not.
- **Test:** `abuse.test.ts › APP_SECRET is mandatory in production even in demo mode`

### SEC-03 — No go-live guard (demo admins, mock OTP, missing secrets) · **High** · Fixed
- **Where:** `lib/startup-checks.ts`, `instrumentation.ts`
- **Reproduce:** deploy with `DEMO_MODE=false` but forget to change `owner@demo.com / Demo@1234` (published in the README) or leave `OTP_PROVIDER=mock`.
- **Impact:** dashboard takeover with public credentials, or OTP codes shown to anyone.
- **Fix:** on a live server, startup **refuses to run** if any of these hold: `APP_SECRET`/`CRON_SECRET` are missing or weak, there's no `DATABASE_URL`, payment or OTP is still on the mock, the site isn't on an https URL, or any demo admin still accepts `Demo@1234`.
- **Test:** `abuse.test.ts › startup check lists every unsafe live setting`

### SEC-05 — Customer phone number and full name exposed to anyone with a booking code · **Medium** · Fixed
- **Where:** `lib/booking/service.ts:259` (`holdResponseFor` prefill), `app/(site)/booking/[code]/page.tsx:53`
- **Reproduce:** `POST /api/bookings/BBA-XXXX/pay` → JSON contained `prefill.phone` = full number; the booking page payload did too.
- **Impact:** anyone who saw a shared booking link learned the customer's mobile number.
- **Fix:** anonymous callers get first name only and no phone; the verified owner still gets prefill. The page shows a masked phone.
- **Test:** `http.spec.ts › SEC-27`, `abuse.test.ts › anyone holding the code does not get the customer's phone number`

### SEC-06 — Rate limits bypassed with a spoofed `X-Forwarded-For` · **High** · Fixed
- **Where:** `lib/ratelimit.ts:37`
- **Reproduce:** send `X-Forwarded-For: <random>` on each request → each gets a fresh per-IP bucket.
- **Impact:** unlimited OTP sends (money) and booking attempts from one machine.
- **Fix:** the client IP comes from the platform header (`x-vercel-forwarded-for` / `x-real-ip`, which Vercel overwrites), otherwise the right-most XFF entry (added by our own proxy). Never the left-most.
- **Test:** `abuse.test.ts › SEC-06 client IP can't be spoofed`

### SEC-07 — Rate limiter race let bursts exceed limits · **Medium** · Fixed
- **Where:** `lib/ratelimit.ts:9`
- **Reproduce:** 20 parallel requests with limit 5 → more than 5 passed (count-then-insert).
- **Fix:** check-and-record runs in one transaction under a per-key `pg_advisory_xact_lock`.
- **Test:** `abuse.test.ts › rate limiter is atomic: 20 parallel hits with limit 5 → exactly 5 allowed`

### SEC-08 — OTP cost abuse: no global cap, per-number race, no verify limit · **High** · Fixed
- **Where:** `lib/otp-service.ts:21`, `app/api/otp/verify/route.ts:10`
- **Reproduce:** rotate through many numbers (and spoofed IPs) → unlimited paid messages; 10 parallel sends to one number issued > 3 codes.
- **Impact:** a large WhatsApp/SMS bill.
- **Fix:** atomic per-number (3/15 min) and per-IP (10/h) limits; **global daily cap** (`Settings.otpDailyCap`, default 300) that pauses codes and sends the owner one WhatsApp alert per day; per-IP limit on verification (40/h). Codes stay hashed (HMAC bound to the phone), expire in 5 min, lock after 5 tries, and are single use.
- **Test:** `abuse.test.ts › 10 parallel sends to one number → only 3 codes issued`, `› global daily cap … alerts the owner once`, `tests/integration › locks a code after 5 wrong attempts`

### SEC-09 — No bot protection on "send code" · **Medium** · Fixed (owner must enable)
- **Where:** `lib/turnstile.ts`, `app/api/otp/send/route.ts:18`, `components/booking/otp-verify.tsx`
- **Fix:** optional Cloudflare Turnstile. With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` set, the widget appears and the server verifies the token before sending. It fails closed: if verification can't be reached, no code is sent.
- **Status:** Needs owner action (create the free Turnstile keys).

### SEC-10 — Slot squatting / book-and-cancel cycling · **High** · Fixed
- **Where:** `lib/booking/service.ts:38` (`enforceBookingLimits`), `app/api/bookings/[code]/cancel/route.ts:18`
- **Reproduce:** one verified number could keep 3 unpaid 10-minute holds forever and book, cancel and rebook without limit; confirmed bookings had no per-number cap.
- **Impact:** one person could block prime evening slots for real customers.
- **Fix (configurable in Settings):** max **2 upcoming bookings** per number (confirmed + live holds); max **4 new bookings per number per 24 h**, cancelled ones included; max **3 customer cancellations per number per day**; 20 cancels/IP/h; 30 booking attempts/IP/h, which also alerts the owner. The checks run inside the hold transaction with the customer row locked.
- **Test:** `abuse.test.ts › max 2 upcoming bookings per number`, `› … counts cancelled ones (book-and-cancel cycling)`

### SEC-11 — Booking codes guessable at scale · **Medium** · Fixed
- **Where:** `lib/booking/service.ts:30`, `app/(site)/booking/[code]/page.tsx:42`
- **Reproduce:** 6 characters from a 31-symbol alphabet (≈ 8.9 × 10⁸) with no limit on page views → scanning is practical.
- **Fix:** 8 characters (≈ 8.5 × 10¹¹, random via `crypto.randomInt`), 60 booking-page views per IP per 10 min, minimal info shown.
- **Test:** `abuse.test.ts › new booking codes are 8 random characters`

### SEC-12 — No-show abuse had no consequence · **Medium** · Fixed
- **Where:** `lib/booking/service.ts:642`, `app/api/admin/customers/route.ts`
- **Fix:** after `noShowBlockThreshold` no-shows (default 3, 0 = off) the number is blocked from online booking. The message is generic ("please call the venue") and doesn't reveal the reason. Phone formats are normalised to `+91XXXXXXXXXX` before lookup, so `+91`, spaces and a leading 0 can't dodge the block. The owner can block or unblock from the customer page.
- **Test:** `abuse.test.ts › 3 no-shows block the number, in every phone format`

### SEC-13 — bcrypt cost 10 · **Low** · Fixed
- **Where:** `lib/auth/admin.ts:21` — cost raised to 12 (configurable via `BCRYPT_COST`). Login stays rate limited (5/account/15 min, 20/IP/15 min) with a generic error and constant-time dummy-hash comparison for unknown emails.

### SEC-14 — Staff could issue refunds and export all customer data · **Medium** · Fixed
- **Where:** `app/api/admin/bookings/[id]/route.ts:52`, `app/api/admin/bookings/export/route.ts:6`
- **Fix:** cancelling with any refund and the CSV export are now **OWNER-only** on the server, and the buttons are hidden for staff.
- **Test:** `http.spec.ts › SEC-14` (anonymous → 401 on all 17 admin routes; STAFF → 403 on all OWNER routes + refund; missing or wrong CSRF → 403)

### SEC-15 — WhatsApp template parameter injection · **Low** · Fixed
- **Where:** `lib/messaging/templates.ts:78`
- **Fix:** all template params are flattened to one line (Meta rejects newlines and tabs) and length-capped; names lose `http(s)://`, `www.` and `<>{}` so they can't smuggle links into a business message.
- **Test:** `abuse.test.ts › WhatsApp params can't break the template or add links`

### SEC-16 — Availability endpoint unthrottled · **Low** · Fixed
- `app/api/availability/route.ts:15`: 90 requests/min per IP via an in-memory limiter (no DB write per poll). Queries are indexed and per court/day.

### SEC-17 — Full Razorpay webhook payload stored · **Low** · Fixed
- `lib/booking/service.ts:400`: only `event, id, order_id, amount, status, method` are stored. Email, contact and VPA are dropped. (Razorpay never sends full card numbers.)

### SEC-18 — Phones and OTP-bearing text in server logs; no WhatsApp opt-out · **Medium** · Fixed
- **Where:** `lib/security.ts:52`, `lib/providers/messaging.ts:32`, `app/api/my-bookings/whatsapp/route.ts`, `app/api/admin/customers/route.ts`
- **Fix:** logs show `+91 98XXXXXX21` and never message bodies. Customers can turn WhatsApp off or on in My Bookings, and the owner can do it on the customer page. Opt-in time is stored and changes are audited. Real OTP providers mask the code in the outbox.

### SEC-19 — No request body size limit · **Low** · Fixed
- `lib/errors.ts:74`: JSON bodies over 32 KB are rejected (declared `Content-Length` and actual size). Uploads are capped at 4 MB.
- **Test:** `abuse.test.ts › oversized JSON bodies are rejected`, `http.spec.ts › SEC-19`

### SEC-20 — Gallery uploads kept EXIF/GPS and had no dimension limit · **Medium** · Fixed
- **Where:** `lib/storage.ts:28`
- **Fix:** magic-byte check (JPG/PNG/WebP/AVIF only; SVG and HTML rejected), then **re-encoded with sharp** to WebP. This strips all metadata, rejects images over 40 MP (decompression bombs) and caps size at 2400 px. File names and ids are server-generated UUIDs (no path traversal). Upload and delete are OWNER-only.
- **Test:** `abuse.test.ts › re-encoding strips EXIF/GPS metadata`, `› rejects non-images even with an image extension`

### SEC-21 — Missing CSP, HSTS, Permissions-Policy; framing allowed same-origin · **Medium** · Fixed
- **Where:** `proxy.ts:4`, `next.config.ts`
- **Fix:**
  - **CSP:** per-request nonce with `script-src 'self' 'nonce-…' 'strict-dynamic'` plus Razorpay and Turnstile, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and in production `upgrade-insecure-requests`.
  - **Other headers:** `X-Frame-Options: DENY`, HSTS (production), `Permissions-Policy`, `nosniff`, `Referrer-Policy`.
  - **Admin:** `X-Robots-Tag: noindex` and `Cache-Control: no-store` on admin pages.
  - **No leaks:** no `X-Powered-By`, and no browser source maps.
- **Test:** `http.spec.ts › SEC-21 security headers are present`

### SEC-22 — CSV formula injection with leading spaces · **Low** · Fixed
- `lib/csv.ts`: cells starting with `= + - @ tab CR`, **even after spaces**, are prefixed with `'`; every cell is quoted.
- **Test:** `abuse.test.ts › CSV cells can't run as spreadsheet formulas`, `http.spec.ts › SEC-22` (XSS payloads in name/notes → no script runs in admin views; CSV escaped)

### SEC-28 — Dev dependency advisory (picomatch ReDoS via vitest) · **Low** · Accepted risk
- `npm audit`: 5 high, all `picomatch ≤ 4.0.7` inside the **test runner** (vitest → vite/tinyglobby). No patched picomatch exists yet; the only "fix" is downgrading vitest to v3. It never ships to the website and only processes our own file globs. Re-check with `npm audit` monthly.

### SEC-29 — Attacker can temporarily lock an admin out by failing logins · **Low** · Accepted risk
- The per-account login limit (5 per 15 min) that stops password guessing can also be triggered by someone else. Accepted: it clears after 15 minutes, and the owner can still use another admin account.

### Accepted / informational
- **SEC-30 (Info):** CSP keeps `style-src 'unsafe-inline'` (React style attributes). Scripts are nonce-locked, so this can't run code.
- **SEC-31 (Info):** anyone holding a booking code can request an OTP *to that booking's phone* (for cancelling). It reveals nothing new and is bounded by the per-number and daily caps.
- **SEC-24 (Info):** cron endpoints are open **only in dev** when `CRON_SECRET` is unset. In production the secret is enforced, and the startup check requires it.
- **SEC-32 (Info · Needs owner action, only if using Supabase):** the app connects with the database role (`DATABASE_URL`) and never ships an anon key. If you use Supabase, still **enable Row Level Security on every table with no policies**, so the public anon key can't read anything through Supabase's auto-generated API.

---

## 4. Checks that passed (no change needed)

- **Double booking:** the Postgres exclusion constraint `no_overlap` is present in the migrated DB. 50 parallel bookings for one slot gave exactly 1 success; overlapping 6–8 and 7–9 gave one rejected. (`abuse.test.ts › SEC-04`)
- **Walk-in clash:** a walk-in on a held or confirmed slot is rejected by the same constraint.
- **Booking rules on the server:** past times, outside opening hours, blocked slots, beyond max-days-ahead, non-consecutive slots, zero duration and inactive courts are all rejected.
- **Timezone:** midnight-IST and UTC date-change cases are covered by `tests/unit/slots.test.ts`.
- **Idempotency:** double submit with the same key gives one booking.
- **Price/status tampering:** `status`, `totalAmount`, `advanceAmount`, `source`, `discountAmount` and `role` are ignored (`http.spec.ts › SEC-26`).
- **Booking without OTP:** 401 (`SEC-26`).
- **Token binding:** phone A's token can't cancel or list phone B's bookings (`SEC-27`).
- **Phone token:** httpOnly, `SameSite=Lax`, `Secure` in production, 30 min, HMAC-signed and tamper-proof (`tests/unit/security.test.ts`).
- **Fake payment verify:** made-up order, payment and signature → 400; constant-time HMAC compare (`SEC-25`).
- **Webhook forgery:** no or wrong signature → 400, signature checked on the **raw** body. Replay and duplicate events → one confirmation, one Payment row, one WhatsApp message. An amount mismatch is not confirmed and is audit-logged. A late payment after hold expiry with the slot taken is auto-refunded (`tests/integration`).
- **Order reuse:** each Payment row is bound to one booking by order id; an already-paid order is a no-op.
- **Refund abuse:** two parallel cancels → one cancellation, one refund, one message. The 2-hour cutoff and "no online cancel after start" are enforced on the server (`abuse.test.ts › SEC-23`).
- **SQL injection:** every query is parameterised (Drizzle / `sql` tag). The only string-built SQL is the migration runner's file name from disk.
- **XSS:** React escapes all output. The only `dangerouslySetInnerHTML` uses are JSON-LD (escaped `<`) and the QR SVG generated from the server-made booking code.
- **Open redirect:** no `next` / `returnUrl` parameters exist.
- **SSRF:** no server fetch of user-supplied URLs.
- **Mass assignment (admin):** settings, courts, gallery and customer PATCH use explicit Zod schemas.
- **CSRF:** every admin write needs the double-submit token **and** a same-origin `Origin`. Public writes rely on SameSite=Lax cookies.
- **CORS:** no `Access-Control-Allow-Origin` is sent, so browsers block cross-origin reads.
- **Sessions:** a random 256-bit token (only its SHA-256 is stored), httpOnly, a new one issued at every login, deleted on logout, 12 h expiry.
- **Enumeration:** login says "Incorrect email or password" in both cases, and OTP send doesn't reveal whether a number has bookings or is blocked.
- **Errors:** unexpected errors return a generic message; no stack traces, SQL or paths in production.
- **Audit log:** there is no UI or API to edit or delete entries.
- **Secrets:** `.env*` is git-ignored, `.env.example` has placeholders only, and the git history holds no real secrets (only the documented local Docker example `postgres:postgres@localhost`). The production client bundle contains no secret names or values and no source maps.
- **Messaging:** messages go only to opted-in numbers (OTP excepted, since it is user-requested). Booking messages only reach a number after it passed OTP. Failed sends never fail a booking and are retried at most 3 times.

---

## 5. Go-live checklist

- [ ] `NODE_ENV=production`, **`DEMO_MODE=false`** (removes the demo banner, disables the mock OTP and mock payment)
- [ ] `APP_SECRET` (32+ random chars), `CRON_SECRET` (16+), `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL=https://…`
- [ ] **Demo admins removed** (`owner@demo.com`, `staff@demo.com`) or their passwords changed. The server won't start otherwise.
- [ ] Razorpay **live** keys + **webhook secret**; webhook URL `https://<domain>/api/webhooks/razorpay` with `payment.captured`, `payment.failed`, `order.paid`
- [ ] `OTP_PROVIDER=whatsapp` (or `sms`) and WhatsApp templates **approved**, including the new `admin_alert` (Utility, one variable `{{1}}`)
- [ ] **Turnstile keys** set (recommended)
- [ ] Owner alert number set in Admin → Settings. Review the spam-protection limits: upcoming bookings per number, bookings per day, no-show block, OTP daily cap.
- [ ] Supabase (if used): RLS on for every table; gallery bucket public-read only
- [ ] Database backups on (e.g. Supabase PITR)
- [ ] Monitoring: alerts on 5xx, on `payment.amount_mismatch` / `booking.refund_failed` audit entries, and on failed messages in the outbox
- [ ] Re-run `npm run test`, `npm run test:e2e`, `npm audit` before each release

---

## 6. What could not be tested, and why

- **gitleaks / trufflehog, semgrep, OWASP ZAP, k6:** none are installed on this machine (no Docker, no Python tools). Substitutes used:
  - a regex secret scan of the working tree **and full git history**, and of the built client bundle;
  - a manual review of every route, Server Component and SQL call against the semgrep Next.js/TypeScript rule themes;
  - HTTP-level tests of headers, auth, CSRF and tampering in place of ZAP;
  - concurrency covered by Vitest scripts (50 parallel bookings, 10 parallel OTP sends, 20 parallel limiter hits) in place of k6.

  Run these tools in CI or on staging before launch.
- **Real Razorpay, WhatsApp Cloud API, MSG91, Turnstile and Supabase:** not used (no accounts; rules of engagement). Their adapters follow each provider's documented signature and auth scheme; the Razorpay HMAC formats are unit-tested against the documented algorithm.
- **Vercel's header behaviour** (`x-real-ip` / `x-vercel-forwarded-for` overwritten by the platform) is documented by Vercel but could not be observed locally.
- **Multi-instance Postgres race behaviour:** tests run on PGlite (a single connection, so it serialises queries). Correctness under true parallelism still holds because the exclusion constraint and advisory locks are enforced by Postgres itself. Still, run the concurrency tests once against the real staging database. The test helpers currently always use PGlite, so point the integration setup at the staging `DATABASE_URL` for that run.
- **Pending-approval booking mode:** not implemented in this product (bookings are confirmed by payment), so not applicable.
- **Password reset / change:** the dashboard has no reset flow, so there are no reset tokens to attack. Admin passwords are changed directly in the database.
