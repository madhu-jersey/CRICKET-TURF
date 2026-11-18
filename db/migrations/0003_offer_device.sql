-- "1 phone, 1 offer": the browser/device that claimed a first-booking discount is recorded on the
-- booking, so a new number entered on the same phone doesn't get the offer again.
ALTER TABLE "Booking" ADD COLUMN "offerDeviceId" text;
CREATE INDEX "Booking_offerDevice_idx" ON "Booking" ("offerDeviceId") WHERE "offerDeviceId" IS NOT NULL;
