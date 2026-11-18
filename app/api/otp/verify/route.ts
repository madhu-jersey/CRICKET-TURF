import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpVerifySchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp-service";
import { getBookingByCode } from "@/lib/booking/data";
import { maskPhone, setPhoneCookie } from "@/lib/auth/phone";
import { clientIp, enforceRateLimit } from "@/lib/ratelimit";

export const POST = handle(async (req: Request) => {
  // Per-network cap on guesses across many numbers (each code also locks after 5 tries). [SEC-08]
  await enforceRateLimit(`otp-verify-ip:${clientIp(req)}`, 40, 60 * 60_000, "Too many attempts. Please try again later.");
  const body = otpVerifySchema.parse(await readJson(req));
  let phone = body.phone;
  if (!phone && body.bookingCode) phone = (await getBookingByCode(body.bookingCode))?.customer.phone;
  if (!phone) throw new AppError("VALIDATION", "Phone number is required.");
  await verifyOtp(phone, body.code);
  await setPhoneCookie(phone);
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone) });
});
