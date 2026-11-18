import { NextResponse } from "next/server";
import { AppError, handle } from "@/lib/errors";
import { bookingCodeSchema } from "@/lib/validation";
import { getVerifiedPhone } from "@/lib/auth/phone";
import { getBookingByCode } from "@/lib/booking/data";
import { cancelBooking } from "@/lib/booking/service";
import { clientIp, enforceRateLimit } from "@/lib/ratelimit";

/** Customer cancellation. Requires the verified-phone cookie of the booking's owner. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  await enforceRateLimit(`cancel-ip:${clientIp(req)}`, 20, 60 * 60_000);
  const code = bookingCodeSchema.parse((await ctx.params).code);
  const d = await getBookingByCode(code);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
  const phone = await getVerifiedPhone();
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Verify your phone number to cancel.");
  if (phone !== d.customer.phone) throw new AppError("FORBIDDEN", "This booking belongs to a different phone number.");
  // Book-and-cancel cycling: at most 3 customer cancellations per number per day. [SEC-10]
  await enforceRateLimit(`cancel-phone:${phone}`, 3, 24 * 3_600_000, "You've cancelled several bookings today. Please call the venue for help.");
  const r = await cancelBooking({ bookingId: d.booking.id, actor: `customer:${phone}`, by: "CUSTOMER", refund: { mode: "POLICY" } });
  return NextResponse.json(r);
});
