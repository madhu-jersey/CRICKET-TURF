import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpSendSchema } from "@/lib/validation";
import { clientIp } from "@/lib/ratelimit";
import { sendOtp } from "@/lib/otp-service";
import { getBookingByCode } from "@/lib/booking/data";
import { maskPhone } from "@/lib/auth/phone";
import { OTP_RESEND_SECONDS } from "@/lib/otp";

export const POST = handle(async (req: Request) => {
  const body = otpSendSchema.parse(await readJson(req));
  let phone: string;
  if ("phone" in body) phone = body.phone;
  else {
    const d = await getBookingByCode(body.bookingCode);
    if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
    phone = d.customer.phone;
  }
  const { devCode, expiresAt } = await sendOtp(phone, clientIp(req));
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone), expiresAt: expiresAt.toISOString(), resendIn: OTP_RESEND_SECONDS, devCode });
});
