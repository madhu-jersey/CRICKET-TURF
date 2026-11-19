-- Refunds whose outcome is unknown (timeout / network / provider 5xx) keep their reservation and are
-- reconciled by looking the refund up by its key. Pending refunds give up after 24 h or 20 attempts
-- and wait for the owner. [SEC-49]
ALTER TABLE "Payment"
  ADD COLUMN "refundInFlightKey" text,
  ADD COLUMN "refundInFlightAmount" integer NOT NULL DEFAULT 0 CHECK ("refundInFlightAmount" >= 0),
  ADD COLUMN "refundInFlightAt" timestamptz;
CREATE INDEX "Payment_refundInFlight_idx" ON "Payment" ("refundInFlightAt") WHERE "refundInFlightKey" IS NOT NULL;

ALTER TABLE "Booking"
  ADD COLUMN "refundPendingSince" timestamptz,
  ADD COLUMN "refundAttempts" integer NOT NULL DEFAULT 0 CHECK ("refundAttempts" >= 0),
  ADD COLUMN "refundNeedsManual" boolean NOT NULL DEFAULT false;
CREATE INDEX "Booking_refundNeedsManual_idx" ON "Booking" ("refundNeedsManual") WHERE "refundNeedsManual";
