/**
 * Device ID for the "one phone, one offer" rule: a random, long-lived httpOnly cookie that
 * identifies this browser. Websites can't read real hardware IDs (IMEI etc.), so clearing site
 * data or using another browser looks like a new device; it stops the common "type a different
 * number on the same phone" trick.
 */
import "server-only";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/security";

export const DEVICE_COOKIE = "bba_dev";
const TWO_YEARS = 2 * 365 * 24 * 3600;

export async function getDeviceId(): Promise<string | null> {
  const v = (await cookies()).get(DEVICE_COOKIE)?.value;
  return v && /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
}

/** Returns the device ID, creating the cookie if this browser doesn't have one yet. */
export async function ensureDeviceId(): Promise<string> {
  const existing = await getDeviceId();
  if (existing) return existing;
  const id = randomToken(24);
  (await cookies()).set(DEVICE_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: env.isProduction, path: "/", maxAge: TWO_YEARS });
  return id;
}
