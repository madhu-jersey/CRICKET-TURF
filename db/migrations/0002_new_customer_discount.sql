-- First-booking offer: new customers (by verified mobile number) get a % off their first online booking.
ALTER TABLE "Settings"
  ADD COLUMN "newCustomerDiscountPercent" integer NOT NULL DEFAULT 10
  CHECK ("newCustomerDiscountPercent" BETWEEN 0 AND 50);

-- Discount given on this booking (₹). totalAmount is the amount after discount.
ALTER TABLE "Booking"
  ADD COLUMN "discountAmount" integer NOT NULL DEFAULT 0
  CHECK ("discountAmount" >= 0);
