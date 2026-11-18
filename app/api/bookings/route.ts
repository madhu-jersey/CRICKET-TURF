import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { createBookingSchema } from "@/lib/validation";
import { clientIp, hitRateLimit } from "@/lib/ratelimit";
import { alertOwner } from "@/lib/alerts";
import { getVerifiedPhone } from "@/lib/auth/phone";
import { createOnlineHold } from "@/lib/booking/service";
import { getDeviceId } from "@/lib/auth/device";

/** Creates a slot hold (PENDING_PAYMENT) and a payment order. Requires a verified phone. */
export const POST = handle(async (req: Request) => {
  const phone = await getVerifiedPhone();
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Please verify your phone number again.");
  const ip = clientIp(req);
  if (!(await hitRateLimit(`booking-ip:${ip}`, 30, 60 * 60_000))) {
    void alertOwner("booking_flood", "Many booking attempts from one network in the last hour — they are being blocked. Check Bookings for spam.");
    throw new AppError("RATE_LIMITED", "Too many booking attempts. Please try again later.");
  }
  const input = createBookingSchema.parse(await readJson(req));
  const hold = await createOnlineHold({ ...input, phone, deviceId: await getDeviceId() });
  return NextResponse.json(hold, { status: 201 });
});
