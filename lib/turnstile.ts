/**
 * Cloudflare Turnstile bot check on "send code". Enabled when TURNSTILE_SECRET_KEY (server) and
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY (browser) are set — and REQUIRED on live sites (startup check).
 * Fails closed, and checks that the token was issued for our hostname and the "otp_send" action,
 * so a token solved on another site or for another widget can't be replayed here. [SEC-09][SEC-34]
 */
import "server-only";
import { env } from "@/lib/env";

export const TURNSTILE_ACTION = "otp_send";

export function turnstileEnabled() {
  return !!env.str("TURNSTILE_SECRET_KEY");
}

/** Hostnames a token may come from: TURNSTILE_HOSTNAMES (comma list) or the site URL's host. */
export function expectedHostnames(): string[] {
  const list = env.str("TURNSTILE_HOSTNAMES");
  if (list) return list.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    return [new URL(env.siteUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

type SiteverifyResult = { success?: boolean; hostname?: string; action?: string; "error-codes"?: string[] };

export function checkSiteverify(r: SiteverifyResult, hostnames: string[]): boolean {
  if (r.success !== true) return false;
  if (r.action !== TURNSTILE_ACTION) return false;
  if (hostnames.length && !hostnames.includes((r.hostname ?? "").toLowerCase())) return false;
  return true;
}

export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = env.str("TURNSTILE_SECRET_KEY");
  if (!secret) return true;
  if (!token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    return checkSiteverify((await res.json()) as SiteverifyResult, expectedHostnames());
  } catch {
    return false; // fail closed: if we can't verify, don't send (each send costs money)
  }
}
