import { NextResponse } from "next/server";
import { AppError, handle } from "@/lib/errors";
import { bookingCodeSchema } from "@/lib/validation";
import { getPhoneProof, isFreshOtp } from "@/lib/auth/phone";
import { cancelBooking, previewCustomerRefund } from "@/lib/booking/service";
import { clientIp, enforceRateLimit } from "@/lib/ratelimit";
import { enforceIpLimit } from "@/lib/ip-limits";
import { getBookingByCode, getSettings } from "@/lib/booking/data";

/** Customer cancellation. Requires the verified-phone cookie of the booking's owner. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  await enforceIpLimit("cancel", clientIp(req), (await getSettings()).cancelPerIpHour);
  const code = bookingCodeSchema.parse((await ctx.params).code);
  const d = await getBookingByCode(code);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
  const proof = await getPhoneProof();
  const phone = proof?.phone;
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Verify your phone number to cancel.");
  if (phone !== d.customer.phone) throw new AppError("FORBIDDEN", "This booking belongs to a different phone number.");
  // A cancel that refunds money needs a code typed just now, even on a remembered device. Checked here
  // first so a refused try doesn't use up one of the day's cancels; cancelBooking checks again inside its
  // transaction with the exact refund figure. [SEC-43]
  const fresh = isFreshOtp(proof);
  if (!fresh && ((await previewCustomerRefund(code))?.refund ?? 0) > 0) {
    throw new AppError("FRESH_OTP_REQUIRED", "For your safety, confirm with a new code sent to your phone before we refund.");
  }
  // Book-and-cancel cycling: at most 3 customer cancellations per number per day. [SEC-10]
  await enforceRateLimit(`cancel-phone:${phone}`, 3, 24 * 3_600_000, "You've cancelled several bookings today. Please call the venue for help.");
  const r = await cancelBooking({ bookingId: d.booking.id, actor: `customer:${phone}`, by: "CUSTOMER", refund: { mode: "POLICY" }, freshOtp: fresh });
  return NextResponse.json(r);
});
