-- Unblocking a customer starts their no-show count again: auto-block counts only no-shows for slots
-- that started after this time. [SEC-57]
ALTER TABLE "Customer" ADD COLUMN "noShowResetAt" timestamptz;

-- Confirmed bookings become COMPLETED this many hours after they end (0 = off). [SEC-59]
ALTER TABLE "Settings" ADD COLUMN "autoCompleteHours" integer NOT NULL DEFAULT 6 CHECK ("autoCompleteHours" BETWEEN 0 AND 72);
