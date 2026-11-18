/**
 * Per-network (IP) limits. Mobile carriers (Jio, Airtel…) put many people behind one IP, so these
 * are deliberately loose and owner-editable in Settings; per-number limits, Turnstile and the split
 * OTP caps are the main protection. Hits are logged with a masked IP so the owner can spot real
 * customers being blocked. [SEC-36]
 */
import "server-only";
import { siteConfig } from "@/config/site";
import { AppError } from "@/lib/errors";
import { hitRateLimit } from "@/lib/ratelimit";
import { windowLimit } from "@/lib/counter";
import { audit } from "@/lib/audit";
import { getDb } from "@/db/client";

export type IpLimitKind = "otp-send" | "otp-verify" | "booking" | "cancel";

export const NETWORK_LIMIT_MESSAGE = `Too many requests from your network. Please try again in a few minutes or call us on ${siteConfig.phoneDisplay}.`;

/** 203.0.113.9 → 203.0.x.x · 2401:4900:1c2a::1 → 2401:4900:x */
export function maskIp(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 2).join(".") + ".x.x";
  if (ip.includes(":")) return ip.split(":").slice(0, 2).join(":") + ":x";
  return "unknown";
}

export async function enforceIpLimit(kind: IpLimitKind, ip: string, perHour: number) {
  if (await hitRateLimit(`${kind}-ip:${ip}`, perHour, 60 * 60_000)) return;
  const masked = maskIp(ip);
  console.warn(`[ratelimit] ${kind} limit (${perHour}/h) hit by network ${masked}`);
  // At most one audit entry per network per kind per hour, so the log can't be flooded.
  if (await windowLimit(`iplog:${kind}:${ip}`, 1, 60 * 60_000)) {
    await audit(await getDb(), { actor: "system", action: "security.ip_limit", entity: "Network", entityId: masked, after: { kind, perHour } }).catch(() => {});
  }
  throw new AppError("RATE_LIMITED", NETWORK_LIMIT_MESSAGE);
}
