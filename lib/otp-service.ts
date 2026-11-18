/** OTP issue + verify against the database, with rate limits. */
import "server-only";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { hitRateLimit } from "@/lib/ratelimit";
import { checkOtp, generateOtpCode, hashOtp, OTP_TTL_MS } from "@/lib/otp";
import { getOtpProvider } from "@/lib/providers/otp";
import { getSettings } from "@/lib/booking/data";
import { alertOwner } from "@/lib/alerts";
import { getCounterStore } from "@/lib/counter";
import { enforceIpLimit } from "@/lib/ip-limits";
import { istDateKey } from "@/lib/time";
import type { SettingsRow } from "@/db/schema";

export const OTP_PHONE_LIMIT = { limit: 3, windowMs: 15 * 60_000 };
const RETURNING_WINDOW_MS = 90 * 24 * 3_600_000;
const TWO_DAYS_MS = 2 * 24 * 3_600_000;

export type OtpPool = "new" | "returning";

/** "Returning" = a confirmed/played booking starting within the last 90 days (or upcoming). [SEC-34] */
export async function otpPoolFor(phone: string, now = new Date()): Promise<OtpPool> {
  const db = await getDb();
  const [hit] = await db
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .where(and(eq(schema.customers.phone, phone), inArray(schema.bookings.status, ["CONFIRMED", "COMPLETED"]), gte(schema.bookings.startAt, new Date(now.getTime() - RETURNING_WINDOW_MS))))
    .limit(1);
  return hit ? "returning" : "new";
}

/** Today's cap for a pool, including the owner's "raise today's cap" boost. */
export function otpCapFor(settings: SettingsRow, pool: OtpPool, now = new Date()) {
  const base = pool === "new" ? settings.otpDailyCapNew : settings.otpDailyCapReturning;
  return base + (settings.otpCapBoostDate === istDateKey(now) ? settings.otpCapBoost : 0);
}

export const otpCapKey = (pool: OtpPool, now = new Date()) => `otpcap:${pool}:${istDateKey(now)}`;

/** Today's usage per pool (for the admin Overview). */
export async function otpCapUsage(now = new Date()) {
  const settings = await getSettings();
  const store = getCounterStore();
  const [newUsed, returningUsed] = await Promise.all([store.get(otpCapKey("new", now)), store.get(otpCapKey("returning", now))]);
  return {
    new: { used: newUsed, cap: otpCapFor(settings, "new", now) },
    returning: { used: returningUsed, cap: otpCapFor(settings, "returning", now) },
  };
}

/**
 * Sends a code. Limits: 3 per number per 15 min (atomic), a per-network limit from Settings, and
 * two separate daily caps — one for new numbers and one for returning customers — so an attacker
 * burning fresh numbers can exhaust only the "new" pool while regular customers keep booking.
 * The owner gets one WhatsApp alert at 80 % and one at 100 % of each pool per day. [SEC-08][SEC-34]
 */
export async function sendOtp(phone: string, ip: string, now = new Date()): Promise<{ devCode?: string; expiresAt: Date }> {
  const db = await getDb();
  if (!(await hitRateLimit(`otp-phone:${phone}`, OTP_PHONE_LIMIT.limit, OTP_PHONE_LIMIT.windowMs, now))) {
    throw new AppError("RATE_LIMITED", "Too many codes requested for this number. Please try again in 15 minutes.");
  }
  const settings = await getSettings(db);
  await enforceIpLimit("otp-send", ip, settings.otpSendPerIpHour);
  const pool = await otpPoolFor(phone, now);
  const cap = otpCapFor(settings, pool, now);
  const used = await getCounterStore().incr(otpCapKey(pool, now), new Date(now.getTime() + TWO_DAYS_MS));
  const label = pool === "new" ? "new-number" : "returning-customer";
  if (used >= Math.ceil(cap * 0.8) && used < cap) {
    void alertOwner(`otp_cap_${pool}_80`, `${label} OTP codes at 80% of today's limit (${used}/${cap}). Check for spam; you can raise today's limit in Settings.`, now);
  }
  if (used >= cap) {
    void alertOwner(`otp_cap_${pool}_100`, `${label} OTP limit reached (${cap}) — those codes are paused until midnight. Raise today's limit in Settings if this is real demand.`, now);
  }
  if (used > cap) {
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
