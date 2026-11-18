# Boundary Box Arena — turf booking demo

A complete booking site for a box-cricket + pickleball venue: public website, live slot grid, phone OTP, advance payment, WhatsApp notifications and an owner dashboard. Everything external (payments, OTP, WhatsApp) runs in **mock mode out of the box**; real providers switch on with environment variables.

- **Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS v4 · Postgres + Drizzle ORM (raw SQL migrations) · Zod · Razorpay · Vitest · Playwright
- **Branding:** everything lives in [`config/site.ts`](config/site.ts) (name, phone, address, map, images, FAQ, amenities).

## Quick start (zero setup)

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no `DATABASE_URL`, the app uses **PGlite** — a real Postgres compiled to WebAssembly — stored in `node_modules/.cache/bba-pglite`. On first request it applies the migrations (including the exclusion constraint) and seeds demo data.

- **One-page booking** at `/book`: sport, date, court, time, details, phone OTP and payment on a single screen.
- **New-customer offer:** a mobile number's first online booking gets 10% off (set the % or turn it off in Admin → Settings). It's applied on the server after OTP verification, **once per mobile number and once per phone/browser** (a device-ID cookie), so a new number typed on a phone that already used the offer gets no discount. It's given back only if that discounted hold expires unpaid. Note: websites can't read hardware IDs, so clearing browser data or switching browsers looks like a new phone.
- **Book a slot:** the OTP code appears on screen (demo banner) and in the server log. The mock checkout has **Simulate success / Simulate failure** buttons.
- **Admin:** http://localhost:3000/admin, sign in as `owner@demo.com` / `Demo@1234` (or `staff@demo.com` / `Demo@1234` for the staff role).
- **Message outbox:** `/admin/messages` shows every WhatsApp/OTP message that *would* be sent.

PGlite is single-process. Stop the dev server before running `npm run db:*` against it, and use a real Postgres (`DATABASE_URL`) for Vercel or any multi-instance deployment.

## Using real Postgres (Supabase or Docker)

```bash
# Docker
docker run -d --name bba-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
# .env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

For Supabase, use the connection string from Project Settings → Database (the **transaction pooler** on port 6543 works well on Vercel; `prepare: false` is already set).

```bash
npm run db:migrate   # applies db/migrations/*.sql (idempotent)
npm run db:seed      # demo data (skipped if data already exists)
npm run db:reset     # DROP everything, migrate, seed  ⚠ destructive
```

Migrations are plain SQL in [`db/migrations`](db/migrations) — the source of truth, including what Drizzle can't express (the `btree_gist` exclusion constraint, CHECKs). [`db/schema.ts`](db/schema.ts) mirrors them for typed queries.

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Copy it to `.env` (or `.env.local`) and fill in what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET` | dev fallback | Signs the verified-phone cookie, hashes OTPs. **Required in production.** |
| `DEMO_MODE` | `true` | Demo banner + on-screen OTP. Set `false` to go live. |
| `DATABASE_URL` | – | Postgres. Empty = embedded PGlite. |
| `PAYMENT_PROVIDER` | `mock` | `mock` or `razorpay` |
| `MESSAGING_PROVIDER` | `mock` | `mock`, `meta` (WhatsApp Cloud API) or `bsp` |
| `OTP_PROVIDER` | `mock` | `mock`, `whatsapp` or `sms` (MSG91) |
| `STORAGE_PROVIDER` | `db` | Gallery uploads: `db` (Postgres bytea) or `supabase` |
| `CRON_SECRET` | – | Protects `/api/cron/*`. **Required in production.** |

## Tests

```bash
npm test                 # unit + integration (Vitest)
npm run test:unit        # pricing, slots/IST, OTP, signatures, refund rule, validation
npm run test:integration # real Postgres (in-memory PGlite) with the real constraint
npx playwright install chromium
npm run test:e2e         # builds into .next-e2e, starts a fresh server on :3100, runs desktop + mobile
```

Integration tests cover: 10 parallel bookings for one slot → exactly 1 succeeds; the exclusion constraint rejecting overlaps directly; idempotency keys; webhook delivered twice → one confirmation / one Payment / one WhatsApp message; bad signature and amount-mismatch webhooks; hold expiry freeing the slot (with and without the cron); payment after expiry → confirmed late or auto-refunded if the slot was taken; walk-in vs online clash; cancellation refund rules; OTP single use, attempt lock and rate limits; reminders.

E2E covers: home → book → OTP → pay → confirmation; payment failure → retry → success; cancel with refund; held slot visible as booked to another visitor; admin login → walk-in → block slot → edit price → new price on the public grid.

## How correctness is enforced

- **No double booking:** `no_overlap` exclusion constraint on `Booking` (`courtId` + `tstzrange(startAt, endAt, '[)')`) for `PENDING_PAYMENT` and `CONFIRMED`. Online and walk-in bookings both go through it. A violation (`23P01`) becomes *"This slot was just taken, please pick another."*
- **Holds:** a booking starts as `PENDING_PAYMENT` with `holdExpiresAt = now + holdMinutes`. Availability treats expired holds as free; before inserting, stale overlapping holds are flipped to `EXPIRED` in the same transaction, and the cron does the same in bulk every minute.
- **Payment truth from the server only:** a booking is confirmed only after the checkout signature (HMAC-SHA256 of `order_id|payment_id`) or a signed webhook (`X-Razorpay-Signature`) is verified. `confirmPayment` locks the Payment row, so the callback and webhook can arrive in any order, any number of times. Paid after the hold expired → confirmed if the slot is still free, otherwise auto-refunded and the customer notified.
- **Prices** are computed on the server from `PricingRule` + `Holiday` + `Settings`; the client only sends court, date and times.
- **Times** are stored as UTC `timestamptz`; IST conversion is a fixed +05:30 offset (India has no DST), see [`lib/time.ts`](lib/time.ts).
- **OTP:** 6 digits, stored as HMAC (bound to the phone), 5-minute expiry, single use, 5 attempts, constant-time compare; 3 sends / phone / 15 min and 10 / IP / hour.
- **Messages** are written to `MessageLog` first, then delivered in the background with 3 attempts and exponential backoff. Delivery failures never affect the booking. Dedupe keys make enqueueing idempotent.

## Switching providers to real

### Razorpay
1. Create a Razorpay account and generate **test** keys (Settings → API Keys).
2. Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
3. Add a webhook (Settings → Webhooks) to `https://YOUR_DOMAIN/api/webhooks/razorpay` with events `payment.captured`, `payment.failed`, `order.paid`; put its secret in `RAZORPAY_WEBHOOK_SECRET`.
4. Test with Razorpay's test cards/UPI, then switch to live keys after KYC.

### WhatsApp — Meta Cloud API
1. In Meta Business Manager create a WhatsApp Business app, add a phone number, and generate a permanent system-user token.
2. Create and get approved templates named exactly: `otp_code` (Authentication category, with copy-code button), `booking_confirmed`, `booking_reminder`, `booking_cancelled`, `payment_failed_hold_expiring`, `admin_new_booking`, `admin_alert` (Utility; one variable, used for security alerts such as the OTP daily cap). Body variables `{{1}}…{{n}}` must follow the order in [`lib/messaging/templates.ts`](lib/messaging/templates.ts). Create a Telugu (`te`) version too if you set `MESSAGE_LANGUAGE=te`.
3. Set `MESSAGING_PROVIDER=meta`, `META_WA_TOKEN`, `META_WA_PHONE_NUMBER_ID`.

### WhatsApp — BSP (Interakt / AiSensy / Gupshup)
Set `MESSAGING_PROVIDER=bsp`, `BSP_API_URL`, `BSP_API_KEY` (and `BSP_AUTH_HEADER` / `BSP_AUTH_PREFIX` if your BSP differs). Register the same template names. If your BSP's JSON shape differs, adjust `GenericBspProvider.buildBody` in [`lib/providers/messaging.ts`](lib/providers/messaging.ts).

### OTP
- `OTP_PROVIDER=whatsapp` sends the `otp_code` authentication template through the messaging provider (code masked in the outbox).
- `OTP_PROVIDER=sms` uses the MSG91 Flow API: set `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID` (a DLT-approved template with an `##otp##` variable).
- The mock OTP is refused in production builds unless `DEMO_MODE=true`.

## Deploying to Vercel

1. Create a Supabase project, run `npm run db:migrate` against it (and `db:seed` if you want demo data).
2. Import the repo in Vercel and add the environment variables (at least `DATABASE_URL`, `APP_SECRET`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`).
3. [`vercel.json`](vercel.json) schedules `/api/cron/expire-holds` every minute and `/api/cron/send-reminders` every 15 minutes. Per-minute crons need a Vercel Pro plan; on Hobby, change the schedule to daily (or use Supabase `pg_cron` / an external pinger). Availability stays correct either way, because expired holds are always treated as free.
4. Set `STORAGE_PROVIDER=supabase` + Supabase keys if you'd rather keep gallery uploads out of the database (create a **public** bucket named in `SUPABASE_BUCKET`).

## Security

See [SECURITY_REPORT.md](SECURITY_REPORT.md) for the full review: findings, fixes, tests and what to set before launch. Security regression tests live in `tests/security/` (`npm run test:security`). On a live server (`NODE_ENV=production`, `DEMO_MODE=false`) the app **refuses to start** if demo admins, mock providers or missing secrets are still in place.

## Go-live checklist

- [ ] **Razorpay KYC** completed; live keys + live webhook secret set; webhook URL points at the production domain.
- [ ] **Meta Business verification** done and the WhatsApp number approved (display name review).
- [ ] **WhatsApp templates approved** (all six names above, plus Telugu versions if used).
- [ ] SMS fallback: DLT registration + approved OTP template (MSG91), if using `OTP_PROVIDER=sms`.
- [ ] `DEMO_MODE=false`, strong `APP_SECRET` and `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL` set to the real domain.
- [ ] **Custom domain** added in Vercel, HTTPS active, Razorpay website/app details updated to the domain.
- [ ] Owner password changed (or a new OWNER created and the demo users removed), and seed demo bookings cleared (`db:reset` without seeding, or delete from `/admin`).
- [ ] Real address, phone, map link and photos in `config/site.ts` and **Admin → Settings / Gallery**.
- [ ] **Legal pages reviewed** by the owner/lawyer: `/terms`, `/privacy`, `/refund-policy`, `/contact` (Razorpay checks these).
- [ ] Pricing, hours, holidays and cancellation rules confirmed in the admin.
- [ ] Database backups enabled (Supabase PITR or daily backups).

## Project layout

```
app/                 routes: (site) public pages, admin/ dashboard, api/ route handlers
components/          ui/ primitives, site/, booking/ (wizard, OTP, payment), admin/
config/site.ts       all branding
db/                  migrations/*.sql, schema.ts, client.ts, seed.ts, cli.ts
lib/booking/         slot engine (pure), availability, booking service (holds, payments, refunds, crons)
lib/pricing/         price + advance calculation (pure)
lib/providers/       payment (Razorpay/mock), messaging (mock/Meta/BSP), OTP (mock/WhatsApp/SMS)
lib/messaging/       templates + queue/retry
lib/auth/            admin sessions + CSRF, verified-phone cookie, cron auth
tests/               unit/, integration/, e2e/
```
