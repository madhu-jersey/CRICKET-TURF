/** OTP issue + verify against the database, with rate limits. */
import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { hitRateLimit } from "@/lib/ratelimit";
import { checkOtp, generateOtpCode, hashOtp, OTP_TTL_MS } from "@/lib/otp";
import { getOtpProvider } from "@/lib/providers/otp";
import { getSettings } from "@/lib/booking/data";
import { alertOwner } from "@/lib/alerts";

export const OTP_PHONE_LIMIT = { limit: 3, windowMs: 15 * 60_000 };
/** 10 codes per network per hour by default; OTP_IP_LIMIT_PER_HOUR overrides it (the e2e server raises it). */
export const OTP_IP_LIMIT = { limit: Number(process.env.OTP_IP_LIMIT_PER_HOUR) || 10, windowMs: 60 * 60_000 };
const DAY = 24 * 3_600_000;

/**
 * Sends a code. Limits (all atomic, see hitRateLimit): 3 per number per 15 min, 10 per network
 * per hour, and a global daily cap (Settings.otpDailyCap) that alerts the owner — each message
 * costs money, so this bounds the worst-case bill. [SEC-08]
 */
export async function sendOtp(phone: string, ip: string, now = new Date()): Promise<{ devCode?: string; expiresAt: Date }> {
  const db = await getDb();
  if (!(await hitRateLimit(`otp-phone:${phone}`, OTP_PHONE_LIMIT.limit, OTP_PHONE_LIMIT.windowMs, now))) {
    throw new AppError("RATE_LIMITED", "Too many codes requested for this number. Please try again in 15 minutes.");
  }
  if (!(await hitRateLimit(`otp-ip:${ip}`, OTP_IP_LIMIT.limit, OTP_IP_LIMIT.windowMs, now))) {
    throw new AppError("RATE_LIMITED", "Too many codes requested from this network. Please try again later.");
  }
  const settings = await getSettings(db);
  if (!(await hitRateLimit("otp-global", settings.otpDailyCap, DAY, now))) {
    void alertOwner("otp_daily_cap", `OTP daily limit (${settings.otpDailyCap}) reached — codes are paused. Possible abuse; check the outbox.`, now);
    throw new AppError("RATE_LIMITED", "We can't send codes right now. Please call the venue to book.");
  }
  const code = generateOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  // Invalidate older unused codes for this phone so only the latest works.
  await db
    .update(schema.otpRequests)
    .set({ consumedAt: now })
    .where(and(eq(schema.otpRequests.phone, phone), isNull(schema.otpRequests.consumedAt)));
  await db.insert(schema.otpRequests).values({ phone, codeHash: hashOtp(phone, code, env.appSecret), expiresAt, ip, createdAt: now });
  const { devCode } = await getOtpProvider().send(phone, code);
  return { devCode, expiresAt };
}

export async function verifyOtp(phone: string, code: string, now = new Date()): Promise<void> {
  const db = await getDb();
  const [rec] = await db
    .select()
    .from(schema.otpRequests)
    .where(eq(schema.otpRequests.phone, phone))
    .orderBy(desc(schema.otpRequests.createdAt))
    .limit(1);
  if (!rec) throw new AppError("OTP_INVALID", "Please request a new code.");
  const result = checkOtp(rec, code, env.appSecret, now);
  if (result === "OK" || result === "INVALID") {
    // Atomic increment guarded by the attempt limit, so parallel guesses can't exceed it.
    const updated = await db
      .update(schema.otpRequests)
      .set({ attempts: rec.attempts + 1, ...(result === "OK" ? { consumedAt: now } : {}) })
      .where(and(eq(schema.otpRequests.id, rec.id), eq(schema.otpRequests.attempts, rec.attempts), isNull(schema.otpRequests.consumedAt)))
      .returning({ id: schema.otpRequests.id });
    if (updated.length === 0) throw new AppError("OTP_INVALID", "That code was already used. Please request a new one.");
  }
  switch (result) {
    case "OK":
      return;
    case "INVALID": {
      const left = 5 - (rec.attempts + 1);
      throw new AppError(left > 0 ? "OTP_INVALID" : "OTP_LOCKED", left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Please request a new code.");
    }
    case "EXPIRED":
      throw new AppError("OTP_EXPIRED", "This code has expired. Please request a new one.");
    case "CONSUMED":
      throw new AppError("OTP_INVALID", "That code is no longer valid. Please request a new one.");
    case "TOO_MANY_ATTEMPTS":
      throw new AppError("OTP_LOCKED", "Too many incorrect attempts. Please request a new code.");
  }
}
