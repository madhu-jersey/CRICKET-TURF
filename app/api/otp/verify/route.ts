import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpVerifySchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp-service";
import { getBookingByCode } from "@/lib/booking/data";
import { maskPhone, setPhoneCookie } from "@/lib/auth/phone";

export const POST = handle(async (req: Request) => {
  const body = otpVerifySchema.parse(await readJson(req));
  let phone = body.phone;
  if (!phone && body.bookingCode) phone = (await getBookingByCode(body.bookingCode))?.customer.phone;
  if (!phone) throw new AppError("VALIDATION", "Phone number is required.");
  await verifyOtp(phone, body.code);
  await setPhoneCookie(phone);
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone) });
});
