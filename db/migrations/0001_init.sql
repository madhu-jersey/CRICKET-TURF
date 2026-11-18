-- Boundary Box Arena: initial schema.
-- All timestamps are timestamptz (stored in UTC). Money is stored in whole rupees (INR).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "Sport" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name" text NOT NULL UNIQUE CHECK ("name" IN ('CRICKET', 'PICKLEBALL')),
  "description" text NOT NULL DEFAULT '',
  "slotDurationMinutes" integer NOT NULL DEFAULT 60 CHECK ("slotDurationMinutes" BETWEEN 15 AND 240),
  "sortOrder" integer NOT NULL DEFAULT 0
);

CREATE TABLE "Court" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sportId" text NOT NULL REFERENCES "Sport"("id"),
  "name" text NOT NULL,
  "isActive" boolean NOT NULL DEFAULT true,
  "sortOrder" integer NOT NULL DEFAULT 0
);

CREATE TABLE "OperatingHours" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "courtId" text NOT NULL REFERENCES "Court"("id") ON DELETE CASCADE,
  "dayOfWeek" integer NOT NULL CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  "openTime" text NOT NULL CHECK ("openTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "closeTime" text NOT NULL CHECK ("closeTime" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  "isClosed" boolean NOT NULL DEFAULT false,
  UNIQUE ("courtId", "dayOfWeek"),
  CHECK ("isClosed" OR "closeTime" > "openTime")
);

CREATE TABLE "PricingRule" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "courtId" text NOT NULL REFERENCES "Court"("id") ON DELETE CASCADE,
  "dayType" text NOT NULL CHECK ("dayType" IN ('WEEKDAY', 'WEEKEND', 'HOLIDAY')),
  "startTime" text NOT NULL CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "endTime" text NOT NULL CHECK ("endTime" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  "pricePerSlot" integer NOT NULL CHECK ("pricePerSlot" >= 0 AND "pricePerSlot" <= 100000),
  CHECK ("endTime" > "startTime")
);
CREATE INDEX "PricingRule_court_idx" ON "PricingRule" ("courtId", "dayType");

CREATE TABLE "Holiday" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "date" date NOT NULL UNIQUE,
  "name" text NOT NULL
);

CREATE TABLE "BlockedSlot" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "courtId" text NOT NULL REFERENCES "Court"("id") ON DELETE CASCADE,
  "startAt" timestamptz NOT NULL,
  "endAt" timestamptz NOT NULL,
  "reason" text NOT NULL CHECK ("reason" IN ('MAINTENANCE', 'TOURNAMENT', 'PRIVATE_EVENT', 'OTHER')),
  "note" text,
  "recurrenceGroupId" text,
  "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("endAt" > "startAt")
);
CREATE INDEX "BlockedSlot_court_time_idx" ON "BlockedSlot" ("courtId", "startAt");

CREATE TABLE "Customer" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name" text NOT NULL,
  "phone" text NOT NULL UNIQUE CHECK ("phone" ~ '^\+91[6-9][0-9]{9}$'),
  "whatsappOptIn" boolean NOT NULL DEFAULT false,
  "optInAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "OtpRequest" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "phone" text NOT NULL,
  "codeHash" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "consumedAt" timestamptz,
  "ip" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "OtpRequest_phone_idx" ON "OtpRequest" ("phone", "createdAt" DESC);

CREATE TABLE "Booking" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "bookingCode" text NOT NULL UNIQUE,
  "customerId" text NOT NULL REFERENCES "Customer"("id"),
  "courtId" text NOT NULL REFERENCES "Court"("id"),
  "startAt" timestamptz NOT NULL,
  "endAt" timestamptz NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'NO_SHOW')),
  "totalAmount" integer NOT NULL CHECK ("totalAmount" >= 0),
  "advanceAmount" integer NOT NULL CHECK ("advanceAmount" >= 0),
  "balanceAmount" integer NOT NULL CHECK ("balanceAmount" >= 0),
  "balancePaidAt" timestamptz,
  "refundAmount" integer NOT NULL DEFAULT 0,
  "source" text NOT NULL CHECK ("source" IN ('ONLINE', 'WALK_IN', 'PHONE')),
  "holdExpiresAt" timestamptz,
  "cancelledAt" timestamptz,
  "cancelReason" text,
  "idempotencyKey" text UNIQUE,
  "reminderSentAt" timestamptz,
  "notes" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("endAt" > "startAt"),
  CHECK ("advanceAmount" + "balanceAmount" = "totalAmount")
);
CREATE INDEX "Booking_court_time_idx" ON "Booking" ("courtId", "startAt");
CREATE INDEX "Booking_customer_idx" ON "Booking" ("customerId");
CREATE INDEX "Booking_status_idx" ON "Booking" ("status", "holdExpiresAt");

-- The core guarantee: two active bookings on the same court can never overlap.
ALTER TABLE "Booking" ADD CONSTRAINT no_overlap
EXCLUDE USING gist (
  "courtId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED'));

CREATE TABLE "Payment" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "bookingId" text NOT NULL REFERENCES "Booking"("id"),
  "provider" text NOT NULL CHECK ("provider" IN ('razorpay', 'mock', 'CASH', 'UPI', 'CARD')),
  "kind" text NOT NULL DEFAULT 'ADVANCE' CHECK ("kind" IN ('ADVANCE', 'BALANCE')),
  "providerOrderId" text UNIQUE,
  "providerPaymentId" text,
  "amount" integer NOT NULL CHECK ("amount" >= 0),
  "status" text NOT NULL CHECK ("status" IN ('CREATED', 'PAID', 'FAILED', 'REFUNDED')),
  "refundAmount" integer NOT NULL DEFAULT 0 CHECK ("refundAmount" >= 0),
  "providerRefundId" text,
  "paidAt" timestamptz,
  "refundedAt" timestamptz,
  "rawWebhookPayload" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("refundAmount" <= "amount")
);
CREATE INDEX "Payment_booking_idx" ON "Payment" ("bookingId");
CREATE INDEX "Payment_paid_idx" ON "Payment" ("paidAt");

CREATE TABLE "MessageLog" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "bookingId" text REFERENCES "Booking"("id"),
  "phone" text NOT NULL,
  "template" text NOT NULL,
  "language" text NOT NULL DEFAULT 'en',
  "payload" jsonb NOT NULL,
  "renderedText" text NOT NULL DEFAULT '',
  "status" text NOT NULL CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED', 'MOCKED')),
  "provider" text NOT NULL DEFAULT 'mock',
  "attempts" integer NOT NULL DEFAULT 0,
  "providerMessageId" text,
  "error" text,
  "dedupeKey" text UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "MessageLog_created_idx" ON "MessageLog" ("createdAt" DESC);

CREATE TABLE "AdminUser" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "email" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "passwordHash" text NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('OWNER', 'STAFF')),
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "AdminSession" (
  "id" text PRIMARY KEY,
  "adminId" text NOT NULL REFERENCES "AdminUser"("id") ON DELETE CASCADE,
  "csrfToken" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "AuditLog" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "entity" text NOT NULL,
  "entityId" text,
  "before" jsonb,
  "after" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "AuditLog_created_idx" ON "AuditLog" ("createdAt" DESC);

CREATE TABLE "Settings" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "advanceType" text NOT NULL DEFAULT 'FIXED' CHECK ("advanceType" IN ('FIXED', 'PERCENT')),
  "advanceValue" integer NOT NULL DEFAULT 300 CHECK ("advanceValue" >= 0),
  "holdMinutes" integer NOT NULL DEFAULT 10 CHECK ("holdMinutes" BETWEEN 2 AND 60),
  "cancellationCutoffHours" integer NOT NULL DEFAULT 24 CHECK ("cancellationCutoffHours" BETWEEN 0 AND 168),
  "refundPercentBeforeCutoff" integer NOT NULL DEFAULT 100 CHECK ("refundPercentBeforeCutoff" BETWEEN 0 AND 100),
  "maxDaysAhead" integer NOT NULL DEFAULT 14 CHECK ("maxDaysAhead" BETWEEN 1 AND 90),
  "ownerAlertPhone" text,
  "businessName" text NOT NULL,
  "address" text NOT NULL,
  "mapLink" text NOT NULL,
  "phone" text NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "RateLimitHit" (
  "id" bigserial PRIMARY KEY,
  "key" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "RateLimitHit_key_idx" ON "RateLimitHit" ("key", "createdAt");

CREATE TABLE "WebhookEvent" (
  "id" text PRIMARY KEY,
  "type" text NOT NULL,
  "receivedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "StoredFile" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "contentType" text NOT NULL,
  "data" bytea NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "GalleryImage" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "url" text NOT NULL,
  "storageKey" text,
  "category" text NOT NULL CHECK ("category" IN ('CRICKET', 'PICKLEBALL', 'FACILITIES')),
  "alt" text NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isFeatured" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
