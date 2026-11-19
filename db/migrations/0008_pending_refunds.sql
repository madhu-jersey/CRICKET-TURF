-- Money still owed to a customer after a refund call failed. Retried automatically by the
-- 15-minute cron until it reaches 0; the owner is alerted. [SEC-45]
ALTER TABLE "Booking" ADD COLUMN "refundPendingAmount" integer NOT NULL DEFAULT 0 CHECK ("refundPendingAmount" >= 0);
CREATE INDEX "Booking_refundPending_idx" ON "Booking" ("refundPendingAmount") WHERE "refundPendingAmount" > 0;
