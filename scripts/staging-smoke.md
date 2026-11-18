# Staging smoke test — Boundary Box Arena

Run this on **staging** before every go-live and after any change to payments, OTP, Turnstile or admin login.
Never on production. Use **test** Razorpay keys, a WhatsApp/SMS **test** sender, and only phone numbers owned by
the team (never a customer's number).

Time needed: about 30 minutes, two people (one on a phone, one on a laptop).

## 0. Before you start

- [ ] Staging URL is `https://staging.<your-domain>` (or similar). Write it here: `______________________`
- [ ] Staging env has: `DEMO_MODE=false`, `NODE_ENV=production`, test Razorpay keys (`rzp_test_…`),
      `OTP_PROVIDER` = `whatsapp` or `sms` with a test sender, Turnstile site key + secret,
      `TURNSTILE_HOSTNAMES=staging.<your-domain>`, `ADMIN_2FA_REQUIRED` unset or `true`, strong `APP_SECRET` and `CRON_SECRET`.
- [ ] Staging database is its **own** Postgres (not the production one). Migrations applied (`npm run db:migrate`).
- [ ] The server started without a `[startup] Refusing to run in production` message, and with no `WARNING` lines.
- [ ] Two team phones ready: **Phone A** (has never booked) and **Phone B** (has a past confirmed booking on staging).

## 1. Automated checks (read-only)

```powershell
$env:STAGING_URL = "https://staging.example.com"; node scripts/staging-smoke.mjs
```

The script only sends GET requests and unauthenticated POSTs that must be refused. It checks: security headers,
admin APIs return 401 without a session, cron endpoints need the secret, payment verify/webhook reject forged
input, the demo banner is gone, and `/refund-policy` shows the policy. It refuses to run against a host that does
not look like staging or localhost.

- [ ] Script prints `ALL CHECKS PASSED`.

## 2. Customer booking (Phone A, on mobile data — not office Wi‑Fi)

- [ ] Home page loads fast; no "Demo mode" banner.
- [ ] `/book` → pick a slot → enter name + Phone A → **Send code**. The Turnstile check appears (or passes silently).
- [ ] The code arrives on WhatsApp/SMS within 30 s. Wrong code 3× → friendly error; right code → verified.
- [ ] The cancellation line on the form matches **Settings → Cancellation & refunds**.
- [ ] 10% new-customer offer is shown for Phone A.
- [ ] Pay with a Razorpay **test** card/UPI (`success@razorpay`). Confirmation page shows the booking code.
- [ ] WhatsApp confirmation arrives and includes the cancellation line.
- [ ] Booking appears in **Admin → Bookings** with the right amount.
- [ ] Repeat with a failing test payment (`failure@razorpay`) → failure screen → retry works → slot was held meanwhile.

## 3. Trusted device

- [ ] On the same phone/browser, start a second booking with Phone A → **no new code is sent** ("verified on this device").
- [ ] In **Admin → Customers → Phone A → Sign out trusted devices** → next booking asks for a code again.

## 4. Cancellation and refund

- [ ] From the booking status page (Phone A), cancel a booking that is more than the refund cutoff away →
      refund amount matches the policy; Razorpay test dashboard shows the refund.
- [ ] Cancellation WhatsApp arrives with the refund text.
- [ ] Change **Settings → refund cutoff** to a different value → `/refund-policy`, `/book`, the booking status page and
      the next confirmation message all show the new value. Change it back.

## 5. Abuse limits (use team phones only)

- [ ] Request 4 codes for the same number within 15 min → the 4th is refused with a friendly message.
- [ ] **Admin → Overview** shows today's OTP usage (new vs returning) and the caps from Settings.
- [ ] (Optional, with the owner) temporarily set **OTP daily cap (new numbers)** to 2 → the third new number is refused and
      the owner gets the 80% and 100% alerts once each. Use **Raise today's cap** → sends work again. Restore the cap.
- [ ] Per-IP limits are the values the owner agreed (Settings → Network limits).

## 6. Admin login and accounts

- [ ] Owner logs in → a login code is sent to the owner's phone → enter it → Overview. Tick "Trust this device" once.
- [ ] Log out and in again on the same browser → no code needed. Another browser → code needed.
- [ ] **Forgot password** with a real admin email and a made-up email → the page says exactly the same thing.
- [ ] Reset with the code from the owner's phone → old sessions are signed out; the trusted device needs a code again.
- [ ] **Team** → create a staff account → staff logs in with the temporary password → is forced to change it.
- [ ] Staff cannot open Settings, Team, refunds or the CSV export (403 / hidden).
- [ ] Demo accounts `owner@demo.com` / `staff@demo.com` do not exist (or no longer accept `Demo@1234`).

## 7. Payments webhook

- [ ] Razorpay test dashboard → Webhooks → the staging URL shows recent `payment.captured` events with 200 responses.
- [ ] Close the browser right after paying (before the redirect) → the booking still becomes CONFIRMED via the webhook.

## 8. Sign-off

| Item | Who | Date | Result |
|---|---|---|---|
| Automated checks | | | |
| Customer flow | | | |
| Limits | | | |
| Admin / 2FA | | | |
| Webhook | | | |

Record any failure in SECURITY_REPORT.md (section "Staging smoke") before go-live.
