/**
 * Trusted customer device: after a successful OTP we set a signed, httpOnly cookie bound to that
 * phone (and the customer's trustEpoch). If the same phone comes back on the same device, it is
 * verified without sending a new OTP — no message cost, no cap usage. Blocking the number or the
 * owner's "sign out trusted devices" bumps trustEpoch, which invalidates every such cookie.
 * A cookie for phone A never verifies phone B. [SEC-35]
 */
import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { signToken, verifyToken } from "@/lib/security";

export const TRUST_COOKIE = "bba_td";
export const TRUST_TTL_MS = 90 * 24 * 3_600_000;

type TrustPayload = { phone: string; epoch: number; exp: number; purpose: string };

export function issueTrustToken(phone: string, epoch: number, now = Date.now()) {
  return signToken({ phone, epoch, exp: now + TRUST_TTL_MS, purpose: "trusted-device" }, env.appSecret);
}

/** Returns the trusted phone if the token is valid, for this exact phone, and not revoked. */
export async function checkTrustToken(token: string | undefined, phone: string): Promise<boolean> {
  const data = verifyToken<TrustPayload>(token, env.appSecret);
  if (!data || data.purpose !== "trusted-device" || data.phone !== phone) return false;
  const db = await getDb();
  const [c] = await db.select({ epoch: schema.customers.trustEpoch, blocked: schema.customers.isBlocked }).from(schema.customers).where(eq(schema.customers.phone, phone));
  if (c?.blocked) return false;
  return (c?.epoch ?? 0) === data.epoch;
}

export async function setTrustCookie(phone: string) {
  const db = await getDb();
  const [c] = await db.select({ epoch: schema.customers.trustEpoch }).from(schema.customers).where(eq(schema.customers.phone, phone));
  (await cookies()).set(TRUST_COOKIE, issueTrustToken(phone, c?.epoch ?? 0), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge: TRUST_TTL_MS / 1000,
  });
}

export async function readTrustCookie() {
  return (await cookies()).get(TRUST_COOKIE)?.value;
}
