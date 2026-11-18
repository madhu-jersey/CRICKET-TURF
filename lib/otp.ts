/** OTP primitives (pure, unit-tested). Storage + sending live in lib/otp-service.ts. */
import { randomInt } from "node:crypto";
import { hmacHex, safeEqual } from "@/lib/security";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 30;

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Codes are stored as HMAC(secret, phone:code) so a DB leak doesn't reveal live codes. */
export function hashOtp(phone: string, code: string, secret: string): string {
  return hmacHex(secret, `otp:${phone}:${code}`);
}

export type OtpRecord = { codeHash: string; expiresAt: Date; attempts: number; consumedAt: Date | null; phone: string };
export type OtpCheck = "OK" | "EXPIRED" | "CONSUMED" | "TOO_MANY_ATTEMPTS" | "INVALID";

/**
 * Checks a submitted code. The caller must persist `attempts + 1` for every check that isn't
 * rejected before comparison (i.e. INVALID and OK both count as an attempt).
 */
export function checkOtp(rec: OtpRecord, code: string, secret: string, now: Date): OtpCheck {
  if (rec.consumedAt) return "CONSUMED";
  if (rec.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (rec.attempts >= OTP_MAX_ATTEMPTS) return "TOO_MANY_ATTEMPTS";
  if (!/^\d{6}$/.test(code)) return "INVALID";
  return safeEqual(hashOtp(rec.phone, code, secret), rec.codeHash) ? "OK" : "INVALID";
}
