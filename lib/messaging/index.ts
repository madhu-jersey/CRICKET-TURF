/**
 * Message queue: every outgoing WhatsApp message is written to MessageLog first (QUEUED), then
 * delivered in the background with up to 3 attempts and exponential backoff. A failed message
 * never fails the booking that triggered it. `dedupeKey` makes enqueueing idempotent.
 */
import "server-only";
import { eq, and, inArray, lt } from "drizzle-orm";
import { getDb, schema, type Queryable } from "@/db/client";
import { env } from "@/lib/env";
import { getMessagingProvider } from "@/lib/providers/messaging";
import { renderTemplate, type TemplateName } from "@/lib/messaging/templates";
import { runInBackground } from "@/lib/background";
import { maskForLog } from "@/lib/security";
import type { MessageStatus } from "@/db/schema";

export const MAX_MESSAGE_ATTEMPTS = 3;

export type EnqueueInput = {
  phone: string;
  template: TemplateName;
  params: Record<string, string>;
  bookingId?: string | null;
  dedupeKey?: string;
  /** Customer messages require WhatsApp opt-in; owner alerts and OTPs pass `true`. */
  optedIn: boolean;
  /** Stored instead of params (e.g. to mask OTP codes in the outbox). */
  logParams?: Record<string, string>;
};

/** Writes a QUEUED row. Returns its id, or null if skipped (no opt-in) or already queued (dedupe). */
export async function enqueueMessage(q: Queryable, input: EnqueueInput): Promise<string | null> {
  if (!input.optedIn) return null;
  const language = env.messageLanguage;
  const shown = input.logParams ?? input.params;
  const rows = await q
    .insert(schema.messageLogs)
    .values({
      bookingId: input.bookingId ?? null,
      phone: input.phone,
      template: input.template,
      language,
      payload: input.params === shown ? input.params : { ...shown, __masked: "true" },
      renderedText: renderTemplate(input.template, shown, language),
      status: "QUEUED",
      provider: getMessagingProvider().name,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: schema.messageLogs.dedupeKey })
    .returning({ id: schema.messageLogs.id });
  return rows[0]?.id ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers a queued message and returns its final status ("FAILED" after 3 attempts). `realParams`
 * carries unmasked params (OTP codes) that are not stored in the log; when omitted, the stored
 * payload is used.
 */
export async function dispatchMessage(id: string, realParams?: Record<string, string>): Promise<MessageStatus | "MISSING"> {
  const db = await getDb();
  const [row] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.id, id));
  if (!row) return "MISSING";
  if (row.status === "SENT" || row.status === "MOCKED") return row.status;
  const provider = getMessagingProvider();
  const params = realParams ?? row.payload;
  const language = row.language === "te" ? "te" : "en";
  let attempts = row.attempts;
  while (attempts < MAX_MESSAGE_ATTEMPTS) {
    attempts++;
    try {
      const res = await provider.send({
        to: row.phone,
        template: row.template as TemplateName,
        language,
        params,
        text: renderTemplate(row.template as TemplateName, params, language),
      });
      await db
        .update(schema.messageLogs)
        .set({ status: res.mocked ? "MOCKED" : "SENT", attempts, providerMessageId: res.providerMessageId, provider: provider.name, error: null, updatedAt: new Date() })
        .where(eq(schema.messageLogs.id, id));
      return res.mocked ? "MOCKED" : "SENT";
    } catch (e) {
      const error = `Attempt ${attempts}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      const final = attempts >= MAX_MESSAGE_ATTEMPTS;
      await db
        .update(schema.messageLogs)
        .set({ status: final ? "FAILED" : "QUEUED", attempts, error, provider: provider.name, updatedAt: new Date() })
        .where(eq(schema.messageLogs.id, id));
      console.warn(`[messaging] ${row.template} → ${maskForLog(row.phone)} failed (${error})`);
      if (final) return "FAILED";
      await sleep(env.messageRetryBaseMs * 2 ** (attempts - 1));
    }
  }
  return "FAILED";
}

/**
 * One delivery attempt with a deadline and no retries — for OTP codes, where the caller falls back
 * to SMS instead of waiting (three 15 s timeouts plus backoff could take ~48 s). If the deadline
 * passes, the row is marked FAILED; a late WhatsApp delivery is harmless (same code). [SEC-50]
 */
export async function dispatchOnce(id: string, realParams: Record<string, string> | undefined, timeoutMs: number): Promise<MessageStatus | "MISSING"> {
  const db = await getDb();
  const [row] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.id, id));
  if (!row) return "MISSING";
  if (row.status === "SENT" || row.status === "MOCKED") return row.status;
  const provider = getMessagingProvider();
  const params = realParams ?? row.payload;
  const language = row.language === "te" ? "te" : "en";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      provider.send({ to: row.phone, template: row.template as TemplateName, language, params, text: renderTemplate(row.template as TemplateName, params, language) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    const status = res.mocked ? "MOCKED" : "SENT";
    await db.update(schema.messageLogs).set({ status, attempts: row.attempts + 1, providerMessageId: res.providerMessageId, provider: provider.name, error: null, updatedAt: new Date() }).where(eq(schema.messageLogs.id, id));
    return status;
  } catch (e) {
    const error = `Attempt ${row.attempts + 1} (single try): ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await db.update(schema.messageLogs).set({ status: "FAILED", attempts: row.attempts + 1, error, provider: provider.name, updatedAt: new Date() }).where(eq(schema.messageLogs.id, id));
    console.warn(`[messaging] ${row.template} → ${maskForLog(row.phone)} failed (${error})`);
    return "FAILED";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Dispatch several queued messages without blocking the caller. Errors are swallowed and logged. */
export function dispatchInBackground(ids: (string | null | undefined)[]) {
  const list = ids.filter((x): x is string => !!x);
  if (list.length === 0) return;
  runInBackground(async () => {
    for (const id of list) {
      try {
        await dispatchMessage(id);
      } catch (e) {
        console.error("[messaging] dispatch crashed", e);
      }
    }
  });
}

/** Admin "retry" — resets the attempt counter and tries again. */
export async function retryMessage(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.id, id));
  if (!row) return false;
  if (row.payload && (row.payload as Record<string, string>).__masked) return false; // OTPs can't be resent
  await db.update(schema.messageLogs).set({ attempts: 0, status: "QUEUED", error: null, updatedAt: new Date() }).where(eq(schema.messageLogs.id, id));
  await dispatchMessage(id);
  return true;
}

/** Cron safety net: re-dispatch messages stuck in QUEUED (e.g. the instance froze mid-retry). */
export async function redispatchStuck(now = new Date()) {
  const db = await getDb();
  const stuck = await db
    .select({ id: schema.messageLogs.id, payload: schema.messageLogs.payload })
    .from(schema.messageLogs)
    .where(and(inArray(schema.messageLogs.status, ["QUEUED"]), lt(schema.messageLogs.updatedAt, new Date(now.getTime() - 2 * 60_000))))
    .limit(50);
  let n = 0;
  for (const m of stuck) {
    if ((m.payload as Record<string, string>).__masked) {
      await db.update(schema.messageLogs).set({ status: "FAILED", error: "Expired before delivery", updatedAt: new Date() }).where(eq(schema.messageLogs.id, m.id));
      continue;
    }
    await dispatchMessage(m.id);
    n++;
  }
  return n;
}
