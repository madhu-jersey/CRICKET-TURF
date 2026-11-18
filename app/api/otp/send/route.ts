import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpSendSchema } from "@/lib/validation";
import { clientIp } from "@/lib/ratelimit";
import { sendOtp } from "@/lib/otp-service";
import { getBookingByCode } from "@/lib/booking/data";
import { maskPhone } from "@/lib/auth/phone";
import { OTP_RESEND_SECONDS } from "@/lib/otp";
import { verifyTurnstile } from "@/lib/turnstile";

const turnstileField = z.object({ turnstileToken: z.string().max(2048).optional() });

export const POST = handle(async (req: Request) => {
  const raw = await readJson(req);
  const body = otpSendSchema.parse(raw);
  const ip = clientIp(req);
  // Bot check first (no-op unless TURNSTILE_SECRET_KEY is set), so bots can't even reach the limits. [SEC-09]
  if (!(await verifyTurnstile(turnstileField.parse(raw).turnstileToken, ip))) {
    throw new AppError("FORBIDDEN", "Please complete the \"I'm human\" check and try again.");
  }
  let phone: string;
  if ("phone" in body) phone = body.phone;
  else {
    const d = await getBookingByCode(body.bookingCode);
    if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
    phone = d.customer.phone;
  }
  const { devCode, expiresAt } = await sendOtp(phone, ip);
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone), expiresAt: expiresAt.toISOString(), resendIn: OTP_RESEND_SECONDS, devCode });
});
