/** Verified-phone token: a signed, httpOnly, 30-minute cookie issued after a successful OTP. */
import "server-only";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { signToken, verifyToken } from "@/lib/security";

export const PHONE_COOKIE = "bba_vp";
export const PHONE_TOKEN_TTL_MS = 30 * 60_000;

export function issuePhoneToken(phone: string, now = Date.now()): string {
  return signToken({ phone, exp: now + PHONE_TOKEN_TTL_MS, purpose: "phone" }, env.appSecret);
}

export function readPhoneToken(token: string | undefined): string | null {
  const data = verifyToken<{ phone: string; exp: number; purpose: string }>(token, env.appSecret);
  return data && data.purpose === "phone" ? data.phone : null;
}

export async function setPhoneCookie(phone: string) {
  const jar = await cookies();
  jar.set(PHONE_COOKIE, issuePhoneToken(phone), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge: PHONE_TOKEN_TTL_MS / 1000,
  });
}

export async function getVerifiedPhone(): Promise<string | null> {
  const jar = await cookies();
  return readPhoneToken(jar.get(PHONE_COOKIE)?.value);
}

export async function clearPhoneCookie() {
  (await cookies()).delete(PHONE_COOKIE);
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/^\+91/, "");
  return `+91 ${d.slice(0, 2)}•••••${d.slice(-3)}`;
}
