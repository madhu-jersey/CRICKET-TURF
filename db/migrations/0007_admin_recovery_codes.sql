-- Admin 2FA recovery codes: 10 single-use codes per admin, stored only as keyed hashes. [SEC-41]
CREATE TABLE "AdminRecoveryCode" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "adminId" text NOT NULL REFERENCES "AdminUser"("id") ON DELETE CASCADE,
  "codeHash" text NOT NULL,
  "usedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "AdminRecoveryCode_hash_idx" ON "AdminRecoveryCode" ("adminId", "codeHash");
-- When the current set was made (NULL = never; a set is made at the first two-step login).
ALTER TABLE "AdminUser" ADD COLUMN "recoveryCodesAt" timestamptz;
