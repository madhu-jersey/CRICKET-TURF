/**
 * Optional Cloudflare Turnstile bot check on "send code". Enabled when TURNSTILE_SECRET_KEY (server)
 * and NEXT_PUBLIC_TURNSTILE_SITE_KEY (browser) are set; otherwise every request passes. [SEC-09]
 */
import "server-only";
import { env } from "@/lib/env";

export function turnstileEnabled() {
  return !!env.str("TURNSTILE_SECRET_KEY");
}

export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = env.str("TURNSTILE_SECRET_KEY");
  if (!secret) return true;
  if (!token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false; // fail closed: if we can't verify, don't send (each send costs money)
  }
}
