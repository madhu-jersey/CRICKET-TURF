-- Abuse protection (security review): per-phone booking limits, no-show blocking, OTP daily cap.
ALTER TABLE "Settings"
  ADD COLUMN "maxActiveBookingsPerPhone" integer NOT NULL DEFAULT 2 CHECK ("maxActiveBookingsPerPhone" BETWEEN 1 AND 20),
  ADD COLUMN "maxBookingsPerPhonePerDay" integer NOT NULL DEFAULT 4 CHECK ("maxBookingsPerPhonePerDay" BETWEEN 1 AND 50),
  ADD COLUMN "noShowBlockThreshold" integer NOT NULL DEFAULT 3 CHECK ("noShowBlockThreshold" BETWEEN 0 AND 20),
  ADD COLUMN "otpDailyCap" integer NOT NULL DEFAULT 300 CHECK ("otpDailyCap" BETWEEN 10 AND 100000);

-- A blocked number can't book online (e.g. after repeated no-shows). Owner can unblock.
ALTER TABLE "Customer"
  ADD COLUMN "isBlocked" boolean NOT NULL DEFAULT false,
  ADD COLUMN "blockedAt" timestamptz,
  ADD COLUMN "blockedReason" text;
