/** Verified-phone token: a signed, httpOnly, 30-minute cookie issued after a successful OTP. */
import "server-only";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { signToken, verifyToken } from "@/lib/security";

export const PHONE_COOKIE = "bba_vp";
export const PHONE_TOKEN_TTL_MS = 30 * 60_000;

/** A code typed within this window counts as "fresh" (needed for cancels that refund money). [SEC-43] */
export const FRESH_OTP_MS = 10 * 60_000;
/** How the phone was verified: a code just typed ("otp") or a remembered device ("trusted"). */
export type PhoneVia = "otp" | "trusted";
export type PhoneProof = { phone: string; via: PhoneVia; at: number };

export function issuePhoneToken(phone: string, now = Date.now(), via: PhoneVia = "otp"): string {
  return signToken({ phone, exp: now + PHONE_TOKEN_TTL_MS, purpose: "phone", via, at: now }, env.appSecret);
}

export function readPhoneProof(token: string | undefined): PhoneProof | null {
  const data = verifyToken<{ phone: string; exp: number; purpose: string; via?: PhoneVia; at?: number }>(token, env.appSecret);
  if (!data || data.purpose !== "phone") return null;
  // Tokens from before this field existed are treated as device-verified (not fresh).
  return { phone: data.phone, via: data.via === "otp" ? "otp" : "trusted", at: typeof data.at === "number" ? data.at : 0 };
}

export function readPhoneToken(token: string | undefined): string | null {
  return readPhoneProof(token)?.phone ?? null;
}

/** True when the phone was verified by typing a code in the last FRESH_OTP_MS. */
export function isFreshOtp(proof: PhoneProof | null, now = Date.now()) {
  return !!proof && proof.via === "otp" && now - proof.at >= 0 && now - proof.at <= FRESH_OTP_MS;
}

export async function setPhoneCookie(phone: string, via: PhoneVia = "otp") {
  const jar = await cookies();
  jar.set(PHONE_COOKIE, issuePhoneToken(phone, Date.now(), via), {
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

export async function getPhoneProof(): Promise<PhoneProof | null> {
  const jar = await cookies();
  return readPhoneProof(jar.get(PHONE_COOKIE)?.value);
}

export async function clearPhoneCookie() {
  (await cookies()).delete(PHONE_COOKIE);
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/^\+91/, "");
  return `+91 ${d.slice(0, 2)}•••••${d.slice(-3)}`;
}
