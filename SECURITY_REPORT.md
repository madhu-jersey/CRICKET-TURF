# Security Report — Boundary Box Arena

**Scope:** full codebase review + testing of the Next.js turf booking site (box cricket + pickleball): public booking with phone OTP, ₹ advance payment (Razorpay / mock), WhatsApp messaging, owner/staff dashboard.
**Environment:** local only — embedded Postgres (PGlite, real Postgres 17 with the real migrations), mock OTP / WhatsApp / payment providers, isolated production build on `localhost:3100`. No production systems, real payment accounts or real phone numbers were used.
**Date:** 18 Nov 2026 · **Version tested:** `main` + the fixes in this report. **Follow-up round (SEC-33 → SEC-40):** same day, branch `security-review`; real Postgres 17 (embedded, 25 connections) added for race testing. **Third round (SEC-41 → SEC-43):** 19 Nov 2026 — admin recovery codes, admin pages tested on a phone screen, fresh code for refund cancels. **Fourth round (SEC-44 → SEC-48):** same day — defects found while writing `docs/ARCHITECTURE.md`. **Hardening round (SEC-49 onward):** branch `security-hardening`, the remaining risks from `docs/ARCHITECTURE.md` §15.

> Note: this site **keeps online advance payment** (owner decision), so the review covers both the "no payment" checklist (booking abuse, OTP flooding, access control) and the payment checks (fake/forged/replayed payments, refunds).

---

## 1. Summary

| Severity | Found | Fixed | Accepted risk | Needs owner action |
|---|---|---|---|---|
| Critical | 1 | 1 | – | – |
| High | 8 | 8 | – | – |
| Medium | 19 | 19 | – | – |
| Low | 11 | 10 | 1 | – |
| Info | – | – | 3 | 1 (Supabase RLS, if used) |

Counts include the follow-up rounds (SEC-33 → SEC-48). Turnstile is no longer "needs owner action": a live server now refuses to start without it.

**Overall risk after fixes: Low.** Every Critical, High and Medium issue is fixed and covered by an automated test. The code is **safe to go live once the go-live checklist (§5) is done**. The new startup check refuses to run a live (`DEMO_MODE=false`) server until the critical items are set.

**Tests (after the fourth round, 19 Nov 2026):** 127 Vitest tests on PGlite (+10 race tests skipped there), **137/137 on real Postgres 17** (`npm run test:realdb`), **10/10 race tests** with 25 truly parallel connections (`npm run test:concurrency`), **33 Playwright tests** pass (desktop + mobile; 15 desktop-only tests skipped on mobile). All pass. `npm audit --omit=dev`: 0 vulnerabilities.

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

### Follow-up round (SEC-33 → SEC-40)

### SEC-33 — Real-parallel bookings deadlocked and surfaced raw database errors · **High** · Fixed
- **Proof:** the first run of 50 parallel bookings on a real multi-connection Postgres (PGlite had hidden this, it runs one query at a time) took up to 60 s and some requests failed with raw `40P01 deadlock detected` errors instead of "slot taken". Cause: two transactions each flipping stale holds and inserting on the same court/day could lock rows in opposite orders.
- **Fix:** every booking write for a court/day first takes `pg_advisory_xact_lock(hashtext(court|day))` (holds, walk-ins, late payment confirmation), and the transactions are wrapped in `transactionWithRetry` (retries `40P01` / `40001` up to 4 times). The exclusion constraint is still the final guard.
- **Test:** `tests/concurrency/races.test.ts` — 50 parallel → exactly 1 OK + 49 "slot taken", under 15 s, with a check that the requests really overlapped. Test DB helper refuses non-local hosts (`followup.test.ts › SEC-33`).

### SEC-34 — One shared OTP daily cap let an attacker lock out returning customers; Turnstile was optional and unchecked · **Medium** · Fixed
- **Proof:** with a single cap, burning it with fresh numbers stopped every customer from logging in for the rest of the day. Turnstile responses were accepted without checking the hostname or action.
- **Fix:** two pools — **new numbers (200/day)** and **returning numbers (300/day**, confirmed or completed booking in the last 90 days). Owner gets one WhatsApp alert at 80% and one at 100% per pool per day; Overview shows today's counts; owner-only **Raise today's cap** (audited) adds to both pools for today. Turnstile siteverify must match `TURNSTILE_HOSTNAMES` and action `otp_send`, fails closed, and a live server refuses to start without the keys.
- **Tests:** `followup.test.ts › SEC-34` (pool exhaustion doesn't block a returning customer, boost is today-only, hostname/action, startup), `abuse.test.ts` (80/100 alerts once each).

### SEC-35 — Every booking needed a new paid OTP, even from a known device · **Low** · Fixed (cost + abuse)
- **Fix:** after a successful OTP, a 90-day HMAC-signed device cookie bound to that phone and the customer's `trustEpoch`. Same phone on the same device skips the code. Revoked when the customer is blocked (manually or by the no-show rule) or when the owner presses **Sign out trusted devices**.
- **Test:** `followup.test.ts › SEC-35` (wrong phone rejected, revoked by block).

### SEC-36 — Per-network limits were hardcoded and showed a bare error · **Medium** · Fixed
- **Fix:** Settings → Network limits: OTP send 30/h, OTP verify 60/h, booking 60/h, cancel 30/h per IP. The customer sees "Too many requests from your network… call us on <venue phone>". The server logs a masked IP (`203.0.113.x`) and writes one `security.ip_limit` audit entry per IP per hour.
- **Tests:** `followup.test.ts › SEC-36` (limits come from Settings; per-number limits still apply when the IP limit is high).

### SEC-37 — Availability limiter was per-instance, and every poll recomputed the grid · **Medium** · Fixed
- **Fix:** the limiter now uses a shared store (Postgres `Counter` table with an atomic UPSERT, or Upstash if configured), so limits hold across serverless instances. Availability is cached for 12 s and invalidated (shared `CacheVersion` bump) on hold, payment, cancel, walk-in, block and hold expiry.
- **Tests:** `followup.test.ts › SEC-37` (limit holds across two limiter clients; cache reused then invalidated), 20 parallel limiter hits → exactly 5 (`races.test.ts`).

### SEC-38 — No admin password change/reset; owner couldn't manage staff · **Medium** · Fixed
- **Fix:** `/admin/account` (change password: 10+ chars, not common, not the email; signs out other sessions and revokes trusted devices). `/admin/forgot`: same answer for any email; 6-digit code to the registered phone, stored hashed, 10 min, single use, 5 tries, rate limited. `/admin/team` (owner only): create staff with a temporary password (forced change at first login), reset, disable/enable, set phone. `AdminUser.phone` added by migration 0006.
- **Tests:** `followup.test.ts › SEC-38`, `http.spec.ts › SEC-38` (identical forgot-password answers), `http.spec.ts › SEC-14` (staff get 403 on the new owner routes).

### SEC-39 — Dashboard login was password-only · **High** · Fixed
- **Fix:** after the password, a 6-digit code to the admin's phone (WhatsApp, SMS fallback); "Trust this device" for 30 days, revoked by any password change or reset. Codes are bound to one admin and purpose, single use, 5 tries, and don't count against customer OTP caps. On by default for a live site; `ADMIN_2FA_REQUIRED=false` turns it off with a startup warning. The browser test server now runs with 2FA on.
- **Tests:** `followup.test.ts › SEC-39`, `http.spec.ts › SEC-39` (no session before the code, wrong code rejected, trusted device skips it, password change revokes trust), `admin.spec.ts` (real login in the browser).

### SEC-40 — Cancellation/refund rules were written in several places and could disagree · **Low** · Fixed
- **Fix:** one source — Settings (`cancelCutoffHours`, `refundCutoffHours`, `refundPercentBeforeCutoff`, `refundPercentAfterCutoff`) → `lib/policy.ts` → `/refund-policy`, FAQ, booking form, booking status/cancel page, `booking_confirmed` and `booking_cancelled` messages, and the server-side refund calculation.
- **Tests:** `followup.test.ts › SEC-40` (wording from Settings; a grep test fails if cutoff hours or refund percentages are hardcoded), `http.spec.ts › SEC-40` (change Settings → every page shows the new rule, then restored).

### Third round (SEC-41 → SEC-43)

### SEC-41 — Losing the phone locked an admin out of two-step login · **Medium** · Fixed
- **Proof:** with 2FA on (SEC-39), an admin whose phone was lost, stolen or out of credit had no way in except the owner editing the database; for the owner themselves there was no way at all.
- **Fix:** 10 single-use recovery codes per admin (format `ABCDE-FGHJK`, 31-character alphabet without look-alikes, `crypto.randomInt` so no bias; ~49.5 bits each). Made at the admin's first two-step login (claimed atomically so two parallel logins can't make two sets) and **shown once**, with copy/download and an "I've saved them" step. Stored only as HMAC-SHA256 keyed with `APP_SECRET` and bound to the admin, so a database leak alone doesn't give usable codes. A code works only on a live password-checked login challenge (so a code alone can't log anyone in), counts against that challenge's 5 tries, works once (atomic `UPDATE … WHERE usedAt IS NULL`), and never trusts the device. **My account → Recovery codes** shows how many are left and makes a new set (current password required; every old code is deleted). Every creation, regeneration and use is audit-logged; each use sends the owner a WhatsApp alert naming the account and the number of codes left.
- **Tests:** `tests/security/recovery-refund.test.ts › SEC-41` (10 distinct codes, no plaintext stored, one set under parallel first logins, single use, A's code can't finish B's login, needs a live challenge, locks after 5 tries, regenerate replaces all, audit + owner alert); `http.spec.ts › SEC-41` (codes returned at first 2FA login only, recovery login works and doesn't trust the device, reuse refused, regenerate needs the password and old codes stop working); the new route is in the `SEC-14` access-control list.

### SEC-42 — Admin pages were only tested on desktop; several controls were too small to tap · **Low** · Fixed
- **Proof:** running the admin tests on the mobile project (Pixel 7) with a check for sideways scrolling and tap targets under 44×44 px found: schedule toolbar buttons and date picker 32–36 px tall, the slot sheet's Close link ~20 px, walk-in radio buttons and checkbox 13×13 px, the "View" link after a walk-in 39 px wide, bookings-page Export / + Walk-in / paging links 34–38 px tall, booking-drawer buttons and inputs 36–40 px, the settings "Raise today's limits" button 40 px. (Not a security hole, but staff at the ground mis-tapping booking and refund controls is an operational risk.)
- **Fix:** all of those are at least 44 px on phones (desktop sizes unchanged); radios/checkboxes use their whole label as the target. The schedule test also exposed a race in the test itself (clicking a booking while the page was still changing day), fixed by waiting for the URL.
- **Tests:** `tests/e2e/admin-panels.spec.ts` — schedule (move days, open a booking), walk-in, bookings list (search, open the drawer) and settings (save, reload, restore) on **desktop and mobile**; on mobile every page and drawer must have no sideways scroll and no interactive element under 44×44 px (inline text links exempt, as in WCAG 2.5.8).

### SEC-43 — A remembered device was enough to cancel and take a refund · **Medium** · Fixed
- **Proof:** after SEC-35, anyone holding a customer's unlocked phone/browser for 90 days could cancel a paid booking and trigger a refund without a new code.
- **Fix:** the verified-phone cookie now records how the phone was verified (`otp` or `trusted`) and when. A customer cancel that would refund money needs a code typed in the last **10 minutes**; otherwise the server answers `FRESH_OTP_REQUIRED` and nothing changes. "Send code" with `fresh: true` skips the remembered-device shortcut. The check runs in the route (before the 3-cancels-a-day counter, so a refused try doesn't use one up) and again inside the locked cancel transaction, using the exact refund that would be paid. Cancels with nothing to refund (inside the cutoff, or nothing paid online) behave as before. Old cookies without the new fields count as "not fresh". The cancel screen asks for a new code whenever a refund is due. Staff/owner cancels are unchanged.
- **Tests:** `recovery-refund.test.ts › SEC-43` (refused without a fresh code with no change to booking or payment; works with one; no-refund cancels unaffected; admin cancels unaffected; 10-minute window; legacy tokens); `http.spec.ts › SEC-43` (remembered device → 401 `FRESH_OTP_REQUIRED`, booking still confirmed; fresh code → refund; walk-in with no online payment → cancel works on the remembered device); `booking.spec.ts › cancel with refund` (the browser flow now asks for a new code).

### Fourth round (SEC-44 → SEC-48)

Found while writing `docs/ARCHITECTURE.md` from the code (SEC-44 → SEC-47); SEC-48 was exposed by the new SEC-47 test on real Postgres.

### SEC-44 — Gallery images stored in the database never loaded · **Medium** · Fixed
- **Proof:** with the default `STORAGE_PROVIDER=db`, `lib/storage.ts` saves uploads with the URL `/api/files/<id>`, but no such route existed (git history shows it never did). Every uploaded photo was a broken image. Supabase-hosted photos would also have been rejected by `next/image` (host not in `remotePatterns`).
- **Fix:** `app/api/files/[id]/route.ts` serves stored files: UUID ids only, only `image/*` rows (all are WebP re-encoded by `sanitizeImage()`), `Cache-Control: public, max-age=31536000, immutable`, `nosniff`, `default-src 'none'` CSP, `Cross-Origin-Resource-Policy: same-origin`. `next.config.ts` allows `*.supabase.co/storage/v1/object/public/**`.
- **Tests:** `tests/security/review-fixes.test.ts › SEC-44` (stored → served as WebP; unknown and path-like ids 404); `http.spec.ts › SEC-44` (owner uploads a JPEG with EXIF → served as WebP without the metadata → the Next.js image optimiser loads it → after delete it 404s).

### SEC-45 — A failed automatic refund after a late payment was lost · **High** · Fixed
- **Proof:** in `confirmPayment()`, the refund for a late payment whose slot was taken ran after the transaction committed. If the Razorpay refund call failed, the webhook returned 500; Razorpay's retry then found the payment `PAID` and returned `ALREADY_PROCESSED`, so the refund was never retried, nothing was audit-logged and nobody was told. The customer's money stayed with the venue. Separately, two refunds of one payment running at once (e.g. a retry and an owner's manual refund) could both call the provider.
- **Fix:** a failed refund (late payment, customer cancel, admin cancel) records the amount still owed in the new `Booking.refundPendingAmount` (migration 0008), writes `booking.refund_failed`, and alerts the owner (once per booking per day). The webhook returns 200. The 15-minute cron's `retryPendingRefunds()` claims each pending amount with a compare-and-set, refunds, and puts back whatever still fails. Each refund now reserves its amount on the Payment row (`refundAmount + x ≤ amount`) before calling the provider and releases it on failure, so no combination of retries and manual refunds can pay back more than was paid. An owner's manual refund also settles the pending amount. The admin drawer shows "Refund pending", and the customer is told the refund will be retried.
- **Tests:** `review-fixes.test.ts › SEC-45` (late payment with a failing provider → webhook succeeds, pending 300, audit + alert; retry while still failing keeps it; retry after recovery refunds and notifies once; manual refund settles the pending amount so the cron doesn't pay again); `races.test.ts` (3 cron retries + 3 owner refunds in parallel → the provider is called once, ₹300 refunded in total).

### SEC-46 — WhatsApp OTP failures were reported as "code sent" · **Medium** · Fixed
- **Proof:** `WhatsAppOtp.send()` queued the message and returned success even when all three delivery attempts failed (the outbox swallows errors). Customers saw "code sent" and waited for a code that never came, and the admin login's SMS fallback (which only ran when sending threw) could never run — with WhatsApp down, admins with 2FA were locked out.
- **Fix:** `dispatchMessage()` returns the final status; `WhatsAppOtp` throws `PROVIDER_ERROR` when delivery failed. `lib/providers/otp.ts › deliverOtpCode()` is shared by customer OTPs and admin codes: the configured channel first, MSG91 SMS if that fails and its keys are set. If every channel fails, the customer's new code is withdrawn and they see an error.
- **Tests:** `review-fixes.test.ts › SEC-46` (WhatsApp down, no SMS → `PROVIDER_ERROR`, code withdrawn, outbox row FAILED after 3 attempts; WhatsApp down with MSG91 → code sent by SMS; admin login code: error without SMS, SMS with it).

### SEC-47 — A blocked slot and a booking could be created for the same time · **Medium** · Fixed
- **Proof:** blocks are not part of the `no_overlap` exclusion constraint. `createBlocks()` checked for overlapping bookings without any lock, and holds read the slot grid before their transaction, so a block and a hold created at the same moment could both succeed. With the fix removed, the new race test failed 3 runs out of 3 (e.g. "19:00: block OK and 1 of 6 holds OK").
- **Fix:** `createBlocks()` takes the same court-day advisory locks as holds and walk-ins (every IST day a block touches, in sorted order), and holds and walk-ins re-check blocks inside their transaction after the lock (`assertNotBlocked()`).
- **Tests:** `races.test.ts` — 5 rounds of 6 holds + 1 block in parallel on real Postgres: either the block wins and no hold does, or exactly one hold wins and the block is refused.

### SEC-48 — Creating a blocked slot crashed on real Postgres · **Medium** · Fixed
- **Proof:** the SEC-47 test on Postgres 17 failed with `ERR_INVALID_ARG_TYPE` from `createBlocks()`: a JavaScript `Date` was embedded in a raw `sql` fragment. PGlite (used by `npm test` and the e2e server) accepts it; postgres-js (production) does not. On a live site the owner could not block any slot.
- **Fix:** the overlap check uses typed Drizzle operators (`or` / `and` / `gt`). No other raw `sql` fragment embeds a date.
- **Tests:** `races.test.ts` exercises `createBlocks()` on Postgres 17 (CI `concurrency` job). Lesson recorded in `docs/ARCHITECTURE.md` §15: run `npm run test:realdb` before every release, not only `npm test`.

### Hardening round — P1: money and OTP (SEC-49 → SEC-51)

### SEC-49 — A refund retry after a timeout could refund twice · **High** · Fixed
- **Proof:** `refundSinglePayment()` released its reservation whenever the provider call threw. A timeout (or network error, or Razorpay 5xx) can mean Razorpay already made the refund, so the cron's retry would refund again — for a full refund the reservation guard stopped the second one only because nothing was left, but for partial refunds (e.g. a 50 % policy) a second refund fitted within the captured amount. Pending refunds were also retried forever.
- **Fix:** every gateway refund gets a fresh key (`rf_…`), stored on the Payment with the amount and time **before** the call (the same atomic update that reserves the amount, and only if no other refund of that payment is in flight). The key goes to Razorpay as `receipt` and `notes.refund_key`. Timeouts, network errors and 5xx raise `ProviderOutcomeUnknown`: the reservation and key are **kept**. The cron's new `reconcileInFlightRefunds()` (in-flight refunds older than 1 minute) calls `GET /v1/payments/{id}/refunds` and matches the key: found → recorded as done; not found → reservation released, then retried normally. 4xx answers are definite failures and release at once. Pending refunds give up after 20 failed attempts or 24 hours: the booking is marked `refundNeedsManual` (migration 0009), retries stop, the owner gets one alert, and the Overview shows "Refunds needing attention" with a "Mark refunded" action (owner, audit-logged `booking.refund_marked_manual`).
- **Tests:** `tests/security/hardening-p1.test.ts › SEC-49` — timeout but the refund exists → found by key, provider called once (also when the retry runs before the reconcile); timeout and no refund → released and retried exactly once; in-flight refunds younger than a minute untouched; 20 failures → needs manual, exactly 20 provider calls, one alert, owner records it; 24 h → needs manual.

### SEC-50 — OTP fallback to SMS took up to ~48 s when WhatsApp was failing · **Medium** · Fixed
- **Proof:** WhatsApp OTPs went through the outbox's three attempts with 15 s timeouts and 1 s + 2 s backoff sleeps before `deliverOtpCode()` could fall back to SMS.
- **Fix:** OTPs use `dispatchOnce()`: one attempt with a 5 s deadline (`OTP_WHATSAPP_TIMEOUT_MS`), no sleeps; then SMS straight away. Other messages keep the background retries.
- **Tests:** `hardening-p1.test.ts › SEC-50` — a WhatsApp provider that hangs for 10 s: SMS is called between 4.5 s and 6.5 s, the whole request finishes in under 8 s, the outbox row is `FAILED` after 1 attempt.

### SEC-51 — `/api/files/[id]` served any stored image and had no rate limit · **Low** · Fixed
- **Fix:** files are served only if a `GalleryImage` row points at them (`storageKey = 'db:<id>'`); 300 requests per minute per network (shared fixed window) → 429 with `Retry-After`.
- **Tests:** `hardening-p1.test.ts › SEC-51` — a StoredFile with no gallery entry is 404 and is served once it belongs to the gallery; 300 requests pass, the 301st is 429, another network is unaffected.

### SEC-28 — Dev dependency advisory (picomatch ReDoS via vitest) · **Low** · Fixed (resolved upstream)
- Earlier: 5 high advisories in `picomatch` inside the test runner. Re-checked 18 Nov 2026: `npm audit` and `npm audit --omit=dev` both report **0 vulnerabilities**. CI now fails on any high advisory in production dependencies.

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
- [ ] **Turnstile keys** set — **required** (the server refuses to start without them); `TURNSTILE_HOSTNAMES` = the live domain
- [ ] **Owner phone** set (login codes and password resets go there — startup check)
- [ ] **Admin 2FA on** (`ADMIN_2FA_REQUIRED` unset or `true`; the server warns if it is off)
- [ ] **Every admin has saved their recovery codes** (My account shows how many are left); the owner's alert number is set so recovery-code use is reported
- [ ] **Split OTP caps** reviewed (new 200 / returning 300 per day) and **per-IP limits** reviewed (OTP send 30/h, verify 60/h, booking 60/h, cancel 30/h)
- [ ] **Cancellation & refund settings** confirmed by the owner (they drive every page and message)
- [ ] **CI green** on the release commit (`.github/workflows/security.yml`)
- [ ] **Staging smoke test** done and signed off (`scripts/staging-smoke.md`)
- [ ] Owner alert number set in Admin → Settings. Review the spam-protection limits: upcoming bookings per number, bookings per day, no-show block.
- [ ] Supabase (if used): RLS on for every table; gallery bucket public-read only
- [ ] Database backups on (e.g. Supabase PITR)
- [ ] Monitoring: alerts on 5xx, on `payment.amount_mismatch` / `booking.refund_failed` audit entries, and on failed messages in the outbox
- [ ] Re-run `npm run test`, `npm run test:concurrency`, `npm run test:e2e`, `npm audit` before each release (CI does this)

---

## 6. What could not be tested, and why

- **gitleaks, semgrep, OWASP ZAP:** now wired into CI (`.github/workflows/security.yml`, see §7) but **not run locally and not yet run in CI** — this branch hasn't been pushed, and installing them here would mean downloading tools the rules of engagement didn't cover. Local substitutes run instead: a regex secret scan of tracked + untracked files **and full git history** (0 hits), `npm audit` (0), and the HTTP security tests. **First CI run results must be recorded here before launch.**
- **k6 load test:** not run. The race behaviour it would check is covered by `npm run test:concurrency` on real Postgres.
- **Real Razorpay, WhatsApp Cloud API, MSG91, Turnstile and Supabase:** not used (no accounts; rules of engagement). Their adapters follow each provider's documented signature and auth scheme; the Razorpay HMAC formats are unit-tested against the documented algorithm.
- **Vercel's header behaviour** (`x-real-ip` / `x-vercel-forwarded-for` overwritten by the platform) is documented by Vercel but could not be observed locally.
- **Race behaviour on real Postgres:** now tested (SEC-33) on an embedded Postgres 17 with 25 parallel connections, and in CI against a `postgres:17` container. **Not yet run against the Supabase staging database** — do it once with `TEST_DATABASE_URL` + `TEST_DB_ALLOWED_HOSTS` (see README).
- **Pending-approval booking mode:** not implemented in this product (bookings are confirmed by payment), so not applicable.
- **Admin login codes and password-reset codes on real WhatsApp/SMS:** only the mock provider was used. Delivery, the SMS fallback and the masked phone shown on screen need checking on staging (smoke test §6).
- **Turnstile on a real domain:** the hostname/action check is unit-tested against Cloudflare's documented response; it hasn't been tried with real keys.
- **Staging smoke test:** written (`scripts/staging-smoke.md` + read-only `scripts/staging-smoke.mjs`) but **not run**, as instructed.
- **Recovery codes in real life:** whether admins actually store them safely can't be tested; the go-live checklist asks the owner to check. Codes are 10 characters (~49.5 bits) and need the password first, so they are not rate limited beyond the 5 tries per login and 30 per IP per 15 minutes.
- **Tap targets:** checked automatically at one phone size (Pixel 7, 412 px wide) on the four admin pages named in the request. Other admin pages (pricing, courts, gallery, team, audit log) were not part of this pass.
- **Upstash limiter store:** code path written; only the Postgres store was tested (no Upstash account).

---

## 7. CI pipeline (`.github/workflows/security.yml`)

| Job | What it does | Fails the build when | Local result |
|---|---|---|---|
| unit | `npm ci`, typecheck, `npm test` (PGlite) | any test fails | 127 passed, 10 skipped |
| concurrency | `postgres:17` service; `npm run test:concurrency` and `npm run test:realdb` | any test fails | 10/10 and 137/137 (embedded Postgres 17) |
| e2e | Playwright desktop + mobile, incl. HTTP security specs | any test fails | 33 passed, 15 skipped (desktop-only) |
| secrets | gitleaks over the full history (`fetch-depth: 0`) | any leak found | not run locally; regex scan: 0 hits |
| sast | semgrep `p/nextjs p/typescript p/secrets p/owasp-top-ten` | any ERROR finding | not run locally |
| audit | `npm audit --omit=dev --audit-level=high` | high/critical advisory | 0 vulnerabilities |
| zap | ZAP baseline against a local build, rules in `.zap/rules.tsv` | a FAIL-level rule fires | not run locally |

All jobs use mock providers and throwaway databases; no secrets are needed. Reports are uploaded as build artifacts. `.zap/rules.tsv` ignores only informational rules (timestamps, comments in minified bundles) and keeps the `style-src 'unsafe-inline'` finding as a warning (accepted, SEC-30).

**Status: the workflow has not run yet** (branch not pushed). After the first run, record any semgrep/ZAP/gitleaks findings here as new SEC entries — fix them or mark them accepted with a reason.
