# Boundary Box Arena — turf booking demo

A complete booking site for a box-cricket + pickleball venue: public website, live slot grid, phone OTP, advance payment, WhatsApp notifications and an owner dashboard. Everything external (payments, OTP, WhatsApp) runs in **mock mode out of the box**; real providers switch on with environment variables.

- **Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS v4 · Postgres + Drizzle ORM (raw SQL migrations) · Zod · Razorpay · Vitest · Playwright
- **Branding:** everything lives in [`config/site.ts`](config/site.ts) (name, phone, address, map, images, FAQ, amenities).
- **How it works:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains every flow, table, limit and setting, with diagrams. Check its file paths with `node scripts/check-doc-paths.mjs`.

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
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | – | Bot check on "send code". **Required in production.** |
| `TURNSTILE_HOSTNAMES` | site host | Hostnames a Turnstile token may come from. |
| `ADMIN_2FA_REQUIRED` | on when live | Admin login needs a code sent to the admin's phone. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | – | Optional shared limiter store (default: Postgres). |
| `TEST_DATABASE_URL` | – | Real Postgres for the concurrency tests (tests only). |

## Tests

```bash
npm test                 # unit + integration (Vitest)
npm run test:unit        # pricing, slots/IST, OTP, signatures, refund rule, validation
npm run test:integration # real Postgres (in-memory PGlite) with the real constraint
npx playwright install chromium
npm run test:e2e         # builds into .next-e2e, starts a fresh server on :3100, runs desktop + mobile
npm run test:concurrency # race tests on REAL Postgres, 25 parallel connections
npm run test:realdb      # every Vitest suite on real Postgres
```

### Concurrency tests on real Postgres

The default Vitest run uses PGlite, which is single-connection — it can't show real races. `npm run test:concurrency`
runs [`tests/concurrency`](tests/concurrency) against a real Postgres with a 25-connection pool. Each test works in its own
fresh schema (dropped afterwards) and proves the requests really overlapped (it samples `pg_stat_activity` and fails unless
several database connections were busy at the same moment).

- **No setup:** leave `TEST_DATABASE_URL` empty — a throwaway Postgres 17 is started with `embedded-postgres` and deleted after.
- **Docker:** `docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:17`, then
  `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres npm run test:concurrency`.
- **Supabase staging:** use the staging project's *direct* connection string and add its host to `TEST_DB_ALLOWED_HOSTS`.
  The runner refuses any other non-local host, so it can't be pointed at production by mistake.
- CI runs both commands against a `postgres:17` service container ([`.github/workflows/security.yml`](.github/workflows/security.yml)).

Covered: 50 parallel bookings for one slot → exactly 1 succeeds (and quickly, no raw DB errors); overlapping 6–8 vs 7–9
bookings → one wins; 20 limiter hits with limit 5 → exactly 5; 10 OTP sends to one number → 3 codes; one number booking
in parallel with a limit of 2 → exactly 2; double cancel → one refund; duplicate webhooks → one confirmation, one message.


Integration tests cover: 10 parallel bookings for one slot → exactly 1 succeeds; the exclusion constraint rejecting overlaps directly; idempotency keys; webhook delivered twice → one confirmation / one Payment / one WhatsApp message; bad signature and amount-mismatch webhooks; hold expiry freeing the slot (with and without the cron); payment after expiry → confirmed late or auto-refunded if the slot was taken; walk-in vs online clash; cancellation refund rules; OTP single use, attempt lock and rate limits; reminders.

E2E covers: home → book → OTP → pay → confirmation; payment failure → retry → success; cancel with refund; held slot visible as booked to another visitor; admin login → walk-in → block slot → edit price → new price on the public grid.

## How correctness is enforced

- **No double booking:** `no_overlap` exclusion constraint on `Booking` (`courtId` + `tstzrange(startAt, endAt, '[)')`) for `PENDING_PAYMENT` and `CONFIRMED`. Online and walk-in bookings both go through it. A violation (`23P01`) becomes *"This slot was just taken, please pick another."*
- **Holds:** a booking starts as `PENDING_PAYMENT` with `holdExpiresAt = now + holdMinutes`. Availability treats expired holds as free; before inserting, stale overlapping holds are flipped to `EXPIRED` in the same transaction, and the cron does the same in bulk every minute.
- **Payment truth from the server only:** a booking is confirmed only after the checkout signature (HMAC-SHA256 of `order_id|payment_id`) or a signed webhook (`X-Razorpay-Signature`) is verified. `confirmPayment` locks the Payment row, so the callback and webhook can arrive in any order, any number of times. Paid after the hold expired → confirmed if the slot is still free, otherwise auto-refunded and the customer notified.
- **Prices** are computed on the server from `PricingRule` + `Holiday` + `Settings`; the client only sends court, date and times.
- **Times** are stored as UTC `timestamptz`; IST conversion is a fixed +05:30 offset (India has no DST), see [`lib/time.ts`](lib/time.ts).
- **OTP:** 6 digits, stored as HMAC (bound to the phone), 5-minute expiry, single use, 5 attempts, constant-time compare; 3 sends / phone / 15 min; per-IP limits and separate daily caps for new and returning numbers are set in **Admin → Settings**. A phone verified on a device stays trusted there for 90 days (no new code), until the customer is blocked or the owner signs out their devices.
- **Refund cancels** always need a code typed in the last 10 minutes, even on a remembered device; cancels with nothing to refund don't.
- **Cancellation and refunds** come from one place — **Admin → Settings → Cancellation & refunds** — and every page and WhatsApp message reads it ([`lib/policy.ts`](lib/policy.ts)).
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

**Before every deploy:** `npm run release:check` must pass locally (typecheck, both database suites, races, Playwright). See [Tests](#tests).

**Order: migrate → deploy.** A live server refuses to start if the database is missing a migration, and names the missing files.

1. **Database.** Create a Supabase project (or any Postgres). Apply migrations with `DATABASE_URL=<url> npm run deploy:migrate` — it takes an advisory lock so two runs can't overlap, and never seeds. Or run the **migrate-production** GitHub Action (Actions → migrate-production → Run workflow, type `migrate production`); it uses the `PRODUCTION_DATABASE_URL` secret of the `production` environment ([`.github/workflows/migrate-production.yml`](.github/workflows/migrate-production.yml)). Never run `db:seed` on a live database.
2. **Owner account** (with `DATABASE_URL` pointing at the live database):
   - `npm run admin:create -- --email you@venue.in --name "Your Name" --phone +919812345678` — asks for the password without showing it (10+ characters, not common, not your email). Refuses if an active owner exists, unless `--force`.
   - `npm run admin:remove-demo` — deactivates `owner@demo.com` and `staff@demo.com` if they exist.
   - Sign in once: a login code goes to the phone, and 10 recovery codes are shown — save them.
3. **Vercel.** Import the repo and add the environment variables (section above and [`.env.example`](.env.example)). Then deploy.
4. **Scheduled jobs.** See [Scheduled jobs](#scheduled-jobs-crons) below.
5. **Uptime.** Point an uptime monitor at `/api/health` (below).
6. Set `STORAGE_PROVIDER=supabase` + Supabase keys if you'd rather keep gallery uploads out of the database (create a **public** bucket named in `SUPABASE_BUCKET`).

### Scheduled jobs (crons)

Two endpoints, both `GET` with header `Authorization: Bearer <CRON_SECRET>`:

| Endpoint | What it does | Needed how often |
|---|---|---|
| `/api/cron/expire-holds` | Marks unpaid holds as expired | Optional — expired holds are already treated as free everywhere |
| `/api/cron/send-reminders` | 2-hour reminders, stuck-message retry, refund reconcile/retry, cleanup | Every 15 min ideal; **hourly is fine** (a booking starting within 2 h without a reminder gets one on the next run) |

Every job is safe to run late, early or twice. Pick one scheduler:

- **Vercel Pro:** [`vercel.json`](vercel.json) already schedules both (every minute and every 15 minutes). Vercel Hobby is for non-commercial use and rejects schedules more frequent than daily — on Hobby, delete the `crons` block from `vercel.json` and use one of the options below.
- **Supabase `pg_cron` + `pg_net`** (Database → Extensions → enable both), then in the SQL editor:
  ```sql
  select cron.schedule('bba-reminders', '*/15 * * * *', $
    select net.http_get(
      url := 'https://YOUR_DOMAIN/api/cron/send-reminders',
      headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
    ) $);
  ```
  (Store the secret in Supabase Vault if you prefer not to keep it in the job text.)
- **cron-job.org (free):** create a job for `https://YOUR_DOMAIN/api/cron/send-reminders`, every 15 minutes, request method GET, and under *Advanced → Headers* add `Authorization` = `Bearer YOUR_CRON_SECRET`. Optionally a second job for `/api/cron/expire-holds`.

### Health check and error tracking

- `GET /api/health` returns `ok` (200) when the database answers within 2 s, otherwise `unavailable` (503). It needs no auth and returns no data. **UptimeRobot (free):** Add New Monitor → HTTP(s) → URL `https://YOUR_DOMAIN/api/health` → interval 5 minutes → add your e-mail/phone as alert contact.
- **Errors:** set `SENTRY_DSN` (optional) to send unexpected server errors to Sentry, with phone numbers and e-mails masked and no request bodies, headers or cookies. A live server prints a startup warning if it's not set.

## Security

See [SECURITY_REPORT.md](SECURITY_REPORT.md) for the full review: findings, fixes, tests and what to set before launch. Security regression tests live in `tests/security/` (`npm run test:security`). On a live server (`NODE_ENV=production`, `DEMO_MODE=false`) the app **refuses to start** if demo admins, mock providers or missing secrets are still in place.

## Admin accounts

- **Command-line tools** for the live database: `npm run admin:create`, `npm run admin:remove-demo`, `npm run admin:recover -- --email … [--phone +91…]` (see [Deploying](#deploying-to-vercel) and the runbook in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

- **Two-step login:** after the password, a 6-digit code goes to the admin's phone (WhatsApp, SMS fallback). "Trust this device" skips it for 30 days; changing or resetting the password revokes every trusted device and session.
- **Recovery codes:** at the first two-step login each admin gets 10 one-time codes (shown once — save them). If the phone is lost, "Use a recovery code" on the login screen works instead of the SMS code; the owner is alerted each time. Make a new set in My account.
- **Forgot password** (`/admin/forgot`): a reset code goes to the registered phone; the page answers the same whether or not the email exists.
- **Team** (owner only, `/admin/team`): add staff with a temporary password (they must change it at first login), reset passwords, disable/enable, set phones.
- **My account** (`/admin/account`): change your password and phone.

## Go-live checklist

- [ ] **Razorpay KYC** completed; live keys + live webhook secret set; webhook URL points at the production domain.
- [ ] **Meta Business verification** done and the WhatsApp number approved (display name review).
- [ ] **WhatsApp templates approved** (all seven names above, plus Telugu versions if used).
- [ ] SMS fallback: DLT registration + approved OTP template (MSG91), if using `OTP_PROVIDER=sms`.
- [ ] `DEMO_MODE=false`, strong `APP_SECRET` and `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL` set to the real domain.
- [ ] **Custom domain** added in Vercel, HTTPS active, Razorpay website/app details updated to the domain.
- [ ] Owner password changed (or a new OWNER created and the demo users removed), and seed demo bookings cleared (`db:reset` without seeding, or delete from `/admin`).
- [ ] Real address, phone, map link and photos in `config/site.ts` and **Admin → Settings / Gallery**.
- [ ] **Legal pages reviewed** by the owner/lawyer: `/terms`, `/privacy`, `/refund-policy`, `/contact` (Razorpay checks these).
- [ ] Pricing, hours, holidays and cancellation rules confirmed in the admin.
- [ ] Database backups enabled (Supabase PITR or daily backups).
- [ ] **Turnstile keys** set (the server won't start without them) and `TURNSTILE_HOSTNAMES` matches the domain.
- [ ] **Owner phone** set in Team/My account (login codes and password resets go there).
- [ ] **Admin 2FA on** (`ADMIN_2FA_REQUIRED` unset or `true`).
- [ ] **OTP daily caps** (new / returning) and **per-IP limits** reviewed in Admin → Settings.
- [ ] **CI green** on the release commit ([security workflow](.github/workflows/security.yml)).
- [ ] **Staging smoke test** done ([`scripts/staging-smoke.md`](scripts/staging-smoke.md)).

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
