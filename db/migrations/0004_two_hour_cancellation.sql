-- Cancellation policy: full refund of the advance if cancelled at least 2 hours before the slot.
ALTER TABLE "Settings" ALTER COLUMN "cancellationCutoffHours" SET DEFAULT 2;
UPDATE "Settings" SET "cancellationCutoffHours" = 2 WHERE "cancellationCutoffHours" = 24;
