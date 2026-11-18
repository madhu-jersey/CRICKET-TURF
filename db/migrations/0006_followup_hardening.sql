-- Follow-up hardening after the security report (SEC-33 onward).

-- Fixed-window counters (one row per key+window, atomic UPSERT increment) and cache versions.
CREATE TABLE "Counter" (
  "key" text PRIMARY KEY,
  "count" integer NOT NULL DEFAULT 0,
  "expiresAt" timestamptz NOT NULL
);
CREATE INDEX "Counter_expires_idx" ON "Counter" ("expiresAt");

CREATE TABLE "CacheVersion" (
  "key" text PRIMARY KEY,
  "version" bigint NOT NULL DEFAULT 0,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- OTP daily caps split into new / returning pools, plus an owner "raise today's cap" boost. [SEC-34]
ALTER TABLE "Settings" DROP COLUMN "otpDailyCap";
ALTER TABLE "Settings"
  ADD COLUMN "otpDailyCapNew" integer NOT NULL DEFAULT 200 CHECK ("otpDailyCapNew" BETWEEN 10 AND 100000),
  ADD COLUMN "otpDailyCapReturning" integer NOT NULL DEFAULT 300 CHECK ("otpDailyCapReturning" BETWEEN 10 AND 100000),
  ADD COLUMN "otpCapBoost" integer NOT NULL DEFAULT 0 CHECK ("otpCapBoost" BETWEEN 0 AND 100000),
  ADD COLUMN "otpCapBoostDate" date,
  -- Per-IP limits, owner-editable (mobile carriers put many users behind one IP). [SEC-36]
  ADD COLUMN "otpSendPerIpHour" integer NOT NULL DEFAULT 30 CHECK ("otpSendPerIpHour" BETWEEN 1 AND 10000),
  ADD COLUMN "otpVerifyPerIpHour" integer NOT NULL DEFAULT 60 CHECK ("otpVerifyPerIpHour" BETWEEN 1 AND 10000),
  ADD COLUMN "bookingPerIpHour" integer NOT NULL DEFAULT 60 CHECK ("bookingPerIpHour" BETWEEN 1 AND 10000),
  ADD COLUMN "cancelPerIpHour" integer NOT NULL DEFAULT 30 CHECK ("cancelPerIpHour" BETWEEN 1 AND 10000),
  -- One cancellation/refund policy, used everywhere. [SEC-40]
  ADD COLUMN "cancelCutoffHours" integer NOT NULL DEFAULT 0 CHECK ("cancelCutoffHours" BETWEEN 0 AND 168),
  ADD COLUMN "refundPercentAfterCutoff" integer NOT NULL DEFAULT 0 CHECK ("refundPercentAfterCutoff" BETWEEN 0 AND 100);
ALTER TABLE "Settings" RENAME COLUMN "cancellationCutoffHours" TO "refundCutoffHours";

-- Trusted customer devices: bumping trustEpoch revokes every trusted-device cookie for that number. [SEC-35]
ALTER TABLE "Customer" ADD COLUMN "trustEpoch" integer NOT NULL DEFAULT 0;

-- Admin accounts: phone for reset codes + 2FA, forced password change, device-trust revocation. [SEC-38][SEC-39]
ALTER TABLE "AdminUser"
  ADD COLUMN "phone" text CHECK ("phone" IS NULL OR "phone" ~ '^\+91[6-9][0-9]{9}$'),
  ADD COLUMN "mustChangePassword" boolean NOT NULL DEFAULT false,
  ADD COLUMN "trustEpoch" integer NOT NULL DEFAULT 0,
  ADD COLUMN "passwordChangedAt" timestamptz;
UPDATE "AdminUser" SET "phone" = (SELECT "phone" FROM "Settings" WHERE "id" = 1) WHERE "role" = 'OWNER' AND "phone" IS NULL;

CREATE TABLE "AdminCode" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "adminId" text NOT NULL REFERENCES "AdminUser"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL CHECK ("purpose" IN ('RESET', 'LOGIN')),
  "codeHash" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "consumedAt" timestamptz,
  "trustDevice" boolean NOT NULL DEFAULT false,
  "ip" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "AdminCode_admin_idx" ON "AdminCode" ("adminId", "createdAt" DESC);
