import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpVerifySchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp-service";
import { getBookingByCode, getSettings } from "@/lib/booking/data";
import { maskPhone, setPhoneCookie } from "@/lib/auth/phone";
import { setTrustCookie } from "@/lib/auth/trusted-device";
import { clientIp } from "@/lib/ratelimit";
import { enforceIpLimit } from "@/lib/ip-limits";

export const POST = handle(async (req: Request) => {
  // Per-network cap on guesses across many numbers (each code also locks after 5 tries). [SEC-08][SEC-36]
  await enforceIpLimit("otp-verify", clientIp(req), (await getSettings()).otpVerifyPerIpHour);
  const body = otpVerifySchema.parse(await readJson(req));
  let phone = body.phone;
  if (!phone && body.bookingCode) phone = (await getBookingByCode(body.bookingCode))?.customer.phone;
  if (!phone) throw new AppError("VALIDATION", "Phone number is required.");
  await verifyOtp(phone, body.code);
  await setPhoneCookie(phone);
  await setTrustCookie(phone); // remember this device for this number (90 days) [SEC-35]
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone) });
});
