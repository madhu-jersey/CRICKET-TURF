/**
 * Optional error tracking. If SENTRY_DSN is set, unexpected server errors are sent to Sentry via
 * its envelope HTTP API (no SDK, no extra dependency). What is sent: error type, message and stack
 * with Indian phone numbers and e-mail addresses masked, the request method and path (no query
 * string), runtime and environment. Never sent: request bodies, headers, cookies or user data.
 * Fire-and-forget with a 3 s timeout; reporting failures are ignored. [SEC-55]
 */
import { randomUUID } from "node:crypto";

const PHONE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Masks phones and e-mails in free text. */
export function scrub(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

type Dsn = { endpoint: string; publicKey: string };
export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !project) return null;
    return { endpoint: `${u.protocol}//${u.host}/api/${project}/envelope/`, publicKey: u.username };
  } catch {
    return null;
  }
}

/** Builds the Sentry event (exported for tests). */
export function buildEvent(err: unknown, ctx: { method?: string; path?: string } = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const path = ctx.path ? ctx.path.split("?")[0] : undefined;
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    exception: { values: [{ type: e.name, value: scrub(e.message).slice(0, 1000), stacktrace: { frames: [] as unknown[] } }] },
    extra: { stack: scrub(e.stack ?? "").slice(0, 4000) },
    tags: { method: ctx.method ?? "", path: path ? scrub(path) : "" },
  };
}

export function reportError(err: unknown, ctx: { method?: string; path?: string } = {}) {
  const dsn = parseDsn(process.env.SENTRY_DSN?.trim());
  if (!dsn) return;
  const event = buildEvent(err, ctx);
  const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
  void fetch(dsn.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=bba-report/1.0` },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
