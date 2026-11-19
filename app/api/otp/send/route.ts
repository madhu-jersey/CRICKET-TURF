import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handle, readJson } from "@/lib/errors";
import { otpSendSchema } from "@/lib/validation";
import { clientIp } from "@/lib/ratelimit";
import { sendOtp } from "@/lib/otp-service";
import { getBookingByCode } from "@/lib/booking/data";
import { maskPhone, setPhoneCookie } from "@/lib/auth/phone";
import { OTP_RESEND_SECONDS } from "@/lib/otp";
import { verifyTurnstile } from "@/lib/turnstile";
import { checkTrustToken, readTrustCookie } from "@/lib/auth/trusted-device";

const turnstileField = z.object({ turnstileToken: z.string().max(2048).optional() });
// fresh: true = the customer is about to do something that moves money (refund cancel), so always send a real code. [SEC-43]
const freshField = z.object({ fresh: z.boolean().optional() });

export const POST = handle(async (req: Request) => {
  const raw = await readJson(req);
  const body = otpSendSchema.parse(raw);
  const ip = clientIp(req);
  let phone: string;
  if ("phone" in body) phone = body.phone;
  else {
    const d = await getBookingByCode(body.bookingCode);
    if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
    phone = d.customer.phone;
  }
  // Trusted device for this exact number: verify without sending (no cost, no cap). [SEC-35]
  if (!freshField.parse(raw).fresh && (await checkTrustToken(await readTrustCookie(), phone))) {
    await setPhoneCookie(phone, "trusted");
    return NextResponse.json({ ok: true, trusted: true, maskedPhone: maskPhone(phone) });
  }
  // Bot check before any limit is touched (required on live sites). [SEC-09][SEC-34]
  if (!(await verifyTurnstile(turnstileField.parse(raw).turnstileToken, ip))) {
    throw new AppError("FORBIDDEN", "Please complete the \"I'm human\" check and try again.");
  }
  const { devCode, expiresAt } = await sendOtp(phone, ip);
  return NextResponse.json({ ok: true, maskedPhone: maskPhone(phone), expiresAt: expiresAt.toISOString(), resendIn: OTP_RESEND_SECONDS, devCode });
});
