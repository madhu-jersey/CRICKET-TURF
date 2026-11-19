/**
 * Booking write-side: holds, payment confirmation, refunds, cancellation, admin bookings, crons.
 *
 * Correctness model
 * - The `no_overlap` exclusion constraint is the single source of truth for double booking.
 *   Application checks exist only to produce nicer errors; the INSERT is what decides.
 * - A PENDING_PAYMENT hold whose holdExpiresAt has passed is treated as free everywhere; before
 *   inserting, stale holds overlapping the requested range are flipped to EXPIRED in the same
 *   transaction so the constraint no longer counts them.
 * - Only server-verified payment events (checkout signature or signed webhook) confirm bookings,
 *   and confirmation is idempotent via a row lock on the Payment.
 */
import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, lte, lt, or, sql, desc, count } from "drizzle-orm";
import { getDb, pgErrorCode, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, schema, transactionWithRetry, type Queryable, type Tx } from "@/db/client";
import { siteConfig } from "@/config/site";
import { AppError, SLOT_TAKEN_MESSAGE } from "@/lib/errors";
import { priceBreakdown, formatINR } from "@/lib/pricing";
import { pickConsecutive, type Slot } from "@/lib/booking/slots";
import { canCancelOnline, cancelledRefundText, hoursText, policySummary, refundFor } from "@/lib/policy";
import { getBookingByCode, getBookingById, getSettings, loadAvailability, netPaid } from "@/lib/booking/data";
import { getPaymentProvider, ProviderOutcomeUnknown, type CreatedOrder, type ProviderRefund } from "@/lib/providers/payment";
import { enqueueMessage, dispatchInBackground, dispatchMessage } from "@/lib/messaging";
import { runInBackground } from "@/lib/background";
import { invalidateAvailability } from "@/lib/booking/availability-cache";
import { audit } from "@/lib/audit";
import { alertOwner } from "@/lib/alerts";
import { getCounterStore } from "@/lib/counter";
import { randomCode, randomToken } from "@/lib/security";
import { formatDate, formatTimeRange, formatTime, istDateKey } from "@/lib/time";
import { env } from "@/lib/env";
import type { Booking, BookingSource, Payment, SettingsRow } from "@/db/schema";

/** 8 chars from a 31-symbol alphabet ≈ 8.5 × 10¹¹ codes, so codes can't be guessed. [SEC-11] */
const newBookingCode = () => `${siteConfig.bookingCodePrefix}-${randomCode(8)}`;

/** Shown to blocked numbers. Deliberately generic: it doesn't say why. [SEC-12] */
export const BLOCKED_MESSAGE = `We can't take this booking online. Please call ${siteConfig.phoneDisplay} to book.`;

/**
 * Anti-squatting limits for online bookings, checked inside the hold transaction while the
 * customer row is locked (so parallel requests from one number can't exceed them). [SEC-10]
 * - blocked numbers (e.g. repeated no-shows) can't book online
 * - at most `maxActiveBookingsPerPhone` upcoming bookings (confirmed or on hold)
 * - at most `maxBookingsPerPhonePerDay` new bookings per 24 h, cancelled ones included,
 *   which also stops endless book-and-cancel cycles
 */
async function enforceBookingLimits(tx: Tx, customer: { id: string; isBlocked: boolean }, settings: SettingsRow, now: Date) {
  if (customer.isBlocked) throw new AppError("NOT_ALLOWED", BLOCKED_MESSAGE);
  const mine = await tx
    .select({ status: schema.bookings.status, endAt: schema.bookings.endAt, holdExpiresAt: schema.bookings.holdExpiresAt, createdAt: schema.bookings.createdAt })
    .from(schema.bookings)
    .where(eq(schema.bookings.customerId, customer.id));
  const active = mine.filter(
    (b) => (b.status === "CONFIRMED" && b.endAt > now) || (b.status === "PENDING_PAYMENT" && !!b.holdExpiresAt && b.holdExpiresAt > now),
  ).length;
  if (active >= settings.maxActiveBookingsPerPhone) {
    throw new AppError(
      "RATE_LIMITED",
      `You already have ${active} upcoming booking${active === 1 ? "" : "s"}. You can book again after playing or cancelling one.`,
    );
  }
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const today = mine.filter((b) => b.createdAt > dayAgo && b.status !== "EXPIRED").length;
  if (today >= settings.maxBookingsPerPhonePerDay) {
    throw new AppError("RATE_LIMITED", "You've made too many bookings today. Please try again tomorrow or call the venue.");
  }
}

function isConstraint(err: unknown, code: string) {
  return pgErrorCode(err) === code;
}

async function upsertCustomer(tx: Queryable, phone: string, name: string, whatsappOptIn: boolean | undefined, now: Date) {
  const [existing] = await tx.select().from(schema.customers).where(eq(schema.customers.phone, phone)).for("update");
  if (existing) {
    const patch: Partial<typeof schema.customers.$inferInsert> = { name };
    if (whatsappOptIn !== undefined && whatsappOptIn !== existing.whatsappOptIn) {
      patch.whatsappOptIn = whatsappOptIn;
      patch.optInAt = whatsappOptIn ? now : null;
    }
    const [c] = await tx.update(schema.customers).set(patch).where(eq(schema.customers.id, existing.id)).returning();
    return c;
  }
  const [c] = await tx
    .insert(schema.customers)
    .values({ name, phone, whatsappOptIn: !!whatsappOptIn, optInAt: whatsappOptIn ? now : null, createdAt: now })
    .onConflictDoUpdate({ target: schema.customers.phone, set: { name } })
    .returning();
  return c;
}

/**
 * Serialises booking inserts for one court + IST day. Without it, many simultaneous inserts into
 * the same exclusion-constraint range wait on each other's uncommitted rows and Postgres has to
 * break the cycles as deadlocks (1 s each) — 50 parallel requests took up to 60 s and some returned
 * raw errors. With the lock they queue, and each loser fails fast with 23P01 ("slot taken").
 * The exclusion constraint is still what guarantees correctness. [SEC-33]
 */
async function lockCourtDay(tx: Tx, courtId: string, dateKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`slot:${courtId}:${dateKey}`}))`);
}

/** Flip stale (time-expired) holds overlapping [start, end) on a court to EXPIRED. */
async function expireStaleOverlapping(tx: Tx, courtId: string, start: Date, end: Date, now: Date) {
  await tx
    .update(schema.bookings)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      and(
        eq(schema.bookings.courtId, courtId),
        eq(schema.bookings.status, "PENDING_PAYMENT"),
        lte(schema.bookings.holdExpiresAt, now),
        lt(schema.bookings.startAt, end),
        gt(schema.bookings.endAt, start),
      ),
    );
}

/**
 * Re-checks blocks inside the booking transaction, after the court-day lock. The slot grid was read
 * before the transaction, so a block created in between would otherwise be missed (blocks are not
 * part of the exclusion constraint). createBlocks() takes the same lock, so the two serialise. [SEC-47]
 */
async function assertNotBlocked(tx: Tx, courtId: string, start: Date, end: Date) {
  const [hit] = await tx
    .select({ id: schema.blockedSlots.id })
    .from(schema.blockedSlots)
    .where(and(eq(schema.blockedSlots.courtId, courtId), lt(schema.blockedSlots.startAt, end), gt(schema.blockedSlots.endAt, start)))
    .limit(1);
  if (hit) throw new AppError("SLOT_TAKEN", SLOT_TAKEN_MESSAGE);
}

function selectionError(slots: Slot[], times: string[]) {
  const pick = pickConsecutive(slots, times);
  if (pick.ok) return pick;
  if (pick.error === "UNAVAILABLE") throw new AppError("SLOT_TAKEN", SLOT_TAKEN_MESSAGE);
  if (pick.error === "NOT_CONSECUTIVE") throw new AppError("VALIDATION", "Please choose back-to-back slots.");
  if (pick.error === "EMPTY") throw new AppError("VALIDATION", "Please choose at least one slot.");
  throw new AppError("VALIDATION", "That slot doesn't exist for the chosen date. Please pick again.");
}

// ───────────────────────────── First-booking offer ─────────────────────────────

/** A discounted booking counts as "offer used" unless its hold expired unpaid. */
function offerConsumed(r: { status: Booking["status"]; discount: number; holdExpiresAt: Date | null }, now: Date) {
  if (r.discount <= 0) return false;
  if (r.status === "PENDING_PAYMENT") return !!r.holdExpiresAt && r.holdExpiresAt > now;
  return r.status !== "EXPIRED";
}

/**
 * A customer (mobile number) is "new" if they have never had a confirmed/played booking (online
 * or walk-in) and haven't already used the offer. Only holds that expired unpaid give it back.
 */
export async function isNewCustomer(q: Queryable, customerId: string, now = new Date()): Promise<boolean> {
  const rows = await q
    .select({ status: schema.bookings.status, discount: schema.bookings.discountAmount, holdExpiresAt: schema.bookings.holdExpiresAt })
    .from(schema.bookings)
    .where(eq(schema.bookings.customerId, customerId));
  return !rows.some((r) => r.status === "CONFIRMED" || r.status === "COMPLETED" || r.status === "NO_SHOW" || offerConsumed(r, now));
}

/** "1 phone, 1 offer": has this device already claimed the first-booking offer (with any number)? */
export async function deviceUsedOffer(q: Queryable, deviceId: string, now = new Date()): Promise<boolean> {
  const rows = await q
    .select({ status: schema.bookings.status, discount: schema.bookings.discountAmount, holdExpiresAt: schema.bookings.holdExpiresAt })
    .from(schema.bookings)
    .where(eq(schema.bookings.offerDeviceId, deviceId));
  return rows.some((r) => offerConsumed(r, now));
}

export type OfferStatus = { percent: number; reason: "ELIGIBLE" | "OFF" | "RETURNING_NUMBER" | "DEVICE_USED" | "NO_DEVICE" };

/** The offer a verified number would get on this device (0 % with the reason when not eligible). */
export async function offerStatus(phone: string, deviceId: string | null, now = new Date()): Promise<OfferStatus> {
  const db = await getDb();
  const settings = await getSettings(db);
  if (settings.newCustomerDiscountPercent <= 0) return { percent: 0, reason: "OFF" };
  const [c] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, phone));
  if (c && !(await isNewCustomer(db, c.id, now))) return { percent: 0, reason: "RETURNING_NUMBER" };
  if (!deviceId) return { percent: 0, reason: "NO_DEVICE" };
  if (await deviceUsedOffer(db, deviceId, now)) return { percent: 0, reason: "DEVICE_USED" };
  return { percent: settings.newCustomerDiscountPercent, reason: "ELIGIBLE" };
}

// ───────────────────────────── Online hold ─────────────────────────────

export type HoldResponse = {
  bookingCode: string;
  status: Booking["status"];
  holdExpiresAt: string | null;
  subtotal: number;
  discount: number;
  total: number;
  advance: number;
  balance: number;
  order: (CreatedOrder & { provider: "razorpay" | "mock"; keyId: string }) | null;
  prefill: { name: string; phone: string };
};

export async function createOnlineHold(
  input: { courtId: string; date: string; times: string[]; name: string; whatsappOptIn: boolean; idempotencyKey: string; phone: string; deviceId: string | null },
  now = new Date(),
): Promise<HoldResponse> {
  const db = await getDb();

  const [dupe] = await db.select().from(schema.bookings).where(eq(schema.bookings.idempotencyKey, input.idempotencyKey));
  if (dupe) return holdResponseFor(dupe.bookingCode, input.phone, now);

  const settings = await getSettings(db);
  const avail = await loadAvailability(db, input.courtId, input.date, now);
  const pick = selectionError(avail.slots, input.times);
  const slotPrices = pick.slots.map((s) => s.price);
  const startAt = new Date(pick.slots[0].startAt);
  const endAt = new Date(pick.slots[pick.slots.length - 1].endAt);
  const holdExpiresAt = new Date(now.getTime() + settings.holdMinutes * 60_000);

  let booking: Booking;
  try {
    booking = await transactionWithRetry(db, async (tx) => {
      const customer = await upsertCustomer(tx, input.phone, input.name, input.whatsappOptIn, now);
      await enforceBookingLimits(tx, customer, settings, now);
      await lockCourtDay(tx, input.courtId, input.date);
      await assertNotBlocked(tx, input.courtId, startAt, endAt);
      await expireStaleOverlapping(tx, input.courtId, startAt, endAt, now);
      // First-booking offer, decided inside the transaction while the customer row is locked,
      // so two parallel holds from the same new number can't both get it.
      // Both the number and the device must be new. The advisory lock serialises parallel holds
      // from the same device (even with different numbers) so only one can claim the offer.
      let discountPct = 0;
      if (settings.newCustomerDiscountPercent > 0 && input.deviceId && (await isNewCustomer(tx, customer.id, now))) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"offer:" + input.deviceId}))`);
        if (!(await deviceUsedOffer(tx, input.deviceId, now))) discountPct = settings.newCustomerDiscountPercent;
      }
      const price = priceBreakdown(slotPrices, settings, discountPct);
      const noPaymentNeeded = price.advance === 0;
      const [b] = await tx
        .insert(schema.bookings)
        .values({
          bookingCode: newBookingCode(),
          customerId: customer.id,
          courtId: input.courtId,
          startAt,
          endAt,
          status: noPaymentNeeded ? "CONFIRMED" : "PENDING_PAYMENT",
          totalAmount: price.total,
          advanceAmount: price.advance,
          balanceAmount: price.balance,
          discountAmount: price.discount,
          offerDeviceId: price.discount > 0 ? input.deviceId : null,
          source: "ONLINE",
          holdExpiresAt: noPaymentNeeded ? null : holdExpiresAt,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return b;
    });
  } catch (e) {
    if (isConstraint(e, PG_EXCLUSION_VIOLATION)) throw new AppError("SLOT_TAKEN", SLOT_TAKEN_MESSAGE);
    if (isConstraint(e, PG_UNIQUE_VIOLATION)) {
      // Same idempotency key raced in, or (astronomically unlikely) a booking-code collision.
      const [again] = await db.select().from(schema.bookings).where(eq(schema.bookings.idempotencyKey, input.idempotencyKey));
      if (again) return holdResponseFor(again.bookingCode, input.phone, now);
      throw new AppError("INTERNAL", "Please try again.");
    }
    throw e;
  }
  await invalidateAvailability(input.courtId, booking.startAt);
  if (booking.status === "CONFIRMED") notifyConfirmed(booking.id);
  return holdResponseFor(booking.bookingCode, input.phone, now);
}

/** Returns the hold plus a usable payment order (reusing an open order or creating a new one). */
export async function holdResponseFor(code: string, phone: string | null, now = new Date()): Promise<HoldResponse> {
  const d = await getBookingByCode(code);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
  if (phone && d.customer.phone !== phone) throw new AppError("FORBIDDEN", "This booking belongs to a different phone number.");
  const b = d.booking;
  const base = {
    bookingCode: b.bookingCode,
    status: b.status,
    holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
    subtotal: b.totalAmount + b.discountAmount,
    discount: b.discountAmount,
    total: b.totalAmount,
    advance: b.advanceAmount,
    balance: b.balanceAmount,
    // Only the verified owner gets their phone back; anyone else holding the code sees no number. [SEC-05]
    prefill: phone ? { name: d.customer.name, phone: d.customer.phone } : { name: d.customer.name.split(" ")[0], phone: "" },
  };
  if (b.status !== "PENDING_PAYMENT") return { ...base, order: null };
  if (!b.holdExpiresAt || b.holdExpiresAt.getTime() <= now.getTime()) throw new AppError("HOLD_EXPIRED", "Your slot hold expired. Please pick the slot again.");
  const order = await ensureOrder(b, d.payments);
  return { ...base, order };
}

async function ensureOrder(b: Booking, payments: Payment[]) {
  const provider = getPaymentProvider();
  const open = payments.find((p) => p.status === "CREATED" && p.provider === provider.name && p.amount === b.advanceAmount && p.providerOrderId);
  if (open?.providerOrderId) {
    return { orderId: open.providerOrderId, amountPaise: open.amount * 100, currency: "INR" as const, provider: provider.name, keyId: provider.keyId };
  }
  const order = await provider.createOrder({
    amountRupees: b.advanceAmount,
    receipt: b.bookingCode,
    notes: { bookingCode: b.bookingCode },
  });
  const db = await getDb();
  await db.insert(schema.payments).values({
    bookingId: b.id,
    provider: provider.name,
    kind: "ADVANCE",
    providerOrderId: order.orderId,
    amount: b.advanceAmount,
    status: "CREATED",
  });
  return { ...order, provider: provider.name, keyId: provider.keyId };
}

// ───────────────────────────── Payment confirmation ─────────────────────────────

export type ConfirmOutcome = "CONFIRMED" | "CONFIRMED_LATE" | "ALREADY_PROCESSED" | "REFUND_SLOT_TAKEN" | "REFUND_NOT_BOOKABLE" | "AMOUNT_MISMATCH";

/**
 * Called from the checkout callback (after signature verification) and from the
 * `payment.captured` webhook. Safe to call any number of times for the same order.
 */
export async function confirmPayment(
  input: { orderId: string; paymentId: string; amountPaise?: number; raw?: unknown; via: "checkout" | "webhook" },
  now = new Date(),
): Promise<{ bookingCode: string; outcome: ConfirmOutcome }> {
  const db = await getDb();
  const result = await transactionWithRetry(db, async (tx) => {
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.providerOrderId, input.orderId)).for("update");
    if (!payment) throw new AppError("NOT_FOUND", "Unknown payment order.");
    const [booking] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, payment.bookingId)).for("update");
    if (payment.status === "PAID" || payment.status === "REFUNDED") {
      return { booking, payment, outcome: "ALREADY_PROCESSED" as ConfirmOutcome };
    }
    if (input.amountPaise !== undefined && input.amountPaise !== payment.amount * 100) {
      await audit(tx, { actor: "system", action: "payment.amount_mismatch", entity: "Payment", entityId: payment.id, after: { expected: payment.amount * 100, got: input.amountPaise } });
      return { booking, payment, outcome: "AMOUNT_MISMATCH" as ConfirmOutcome };
    }
    const [paid] = await tx
      .update(schema.payments)
      .set({ status: "PAID", providerPaymentId: input.paymentId, paidAt: now, updatedAt: now, rawWebhookPayload: (input.raw ?? null) as never })
      .where(eq(schema.payments.id, payment.id))
      .returning();

    let outcome: ConfirmOutcome;
    if (booking.status === "PENDING_PAYMENT") {
      await tx.update(schema.bookings).set({ status: "CONFIRMED", holdExpiresAt: null, updatedAt: now }).where(eq(schema.bookings.id, booking.id));
      outcome = "CONFIRMED";
    } else if (booking.status === "EXPIRED") {
      // Paid after the hold expired: confirm only if the slot is still free (savepoint so the
      // exclusion violation doesn't abort the outer transaction).
      try {
        await tx.transaction(async (sp) => {
          await lockCourtDay(sp, booking.courtId, istDateKey(booking.startAt));
          await expireStaleOverlapping(sp, booking.courtId, booking.startAt, booking.endAt, now);
          if (booking.startAt.getTime() <= now.getTime()) throw new AppError("NOT_ALLOWED", "Slot already started");
          const blocked = await sp
            .select({ id: schema.blockedSlots.id })
            .from(schema.blockedSlots)
            .where(and(eq(schema.blockedSlots.courtId, booking.courtId), lt(schema.blockedSlots.startAt, booking.endAt), gt(schema.blockedSlots.endAt, booking.startAt)));
          if (blocked.length) throw new AppError("NOT_ALLOWED", "Slot blocked");
          await sp.update(schema.bookings).set({ status: "CONFIRMED", holdExpiresAt: null, updatedAt: now }).where(eq(schema.bookings.id, booking.id));
        });
        outcome = "CONFIRMED_LATE";
      } catch (e) {
        if (!isConstraint(e, PG_EXCLUSION_VIOLATION) && !(e instanceof AppError)) throw e;
        await tx
          .update(schema.bookings)
          .set({ status: "CANCELLED", cancelledAt: now, cancelReason: "Payment received after the hold expired and the slot was taken — auto refund", updatedAt: now })
          .where(eq(schema.bookings.id, booking.id));
        outcome = "REFUND_SLOT_TAKEN";
      }
    } else if (booking.status === "CONFIRMED" || booking.status === "COMPLETED") {
      // A second order for an already-paid booking (e.g. retried in another tab): refund it.
      outcome = "REFUND_NOT_BOOKABLE";
    } else {
      // CANCELLED / REFUNDED / NO_SHOW: never revive — refund.
      outcome = "REFUND_NOT_BOOKABLE";
    }
    await audit(tx, { actor: `system:${input.via}`, action: `payment.${outcome.toLowerCase()}`, entity: "Booking", entityId: booking.id, after: { orderId: input.orderId, paymentId: input.paymentId } });
    return { booking, payment: paid, outcome };
  });

  const code = result.booking.bookingCode;
  if (result.outcome === "AMOUNT_MISMATCH") {
    // Money arrived that doesn't match the order: always worth a look (every occurrence). [SEC-54]
    void alertOwner(
      `amount_mismatch_${result.payment.id}_${now.getTime()}`,
      `Payment amount mismatch on booking ${code}: expected ${formatINR(result.payment.amount)}, Razorpay reported ${formatINR(Math.round((input.amountPaise ?? 0) / 100))}. The booking was NOT confirmed. Check the Razorpay dashboard.`,
      now,
    );
  }
  if (result.outcome !== "ALREADY_PROCESSED" && result.outcome !== "CONFIRMED") await invalidateAvailability(result.booking.courtId, result.booking.startAt);
  if (result.outcome === "CONFIRMED" || result.outcome === "CONFIRMED_LATE") {
    notifyConfirmed(result.booking.id);
  } else if (result.outcome === "REFUND_SLOT_TAKEN" || result.outcome === "REFUND_NOT_BOOKABLE") {
    const wasLive = result.booking.status === "CONFIRMED" || result.booking.status === "COMPLETED";
    // The payment is already recorded as PAID, so a webhook retry would see ALREADY_PROCESSED and never
    // refund. A failed refund call is therefore recorded as pending (retried by the cron, owner
    // alerted) instead of being thrown away with a 500. [SEC-45]
    try {
      await refundSinglePayment(result.payment, result.payment.amount, "system", now);
    } catch (e) {
      await recordPendingRefund(result.booking.id, result.payment.amount, "system", e, now);
      return { bookingCode: code, outcome: result.outcome };
    }
    if (!wasLive) {
      await db
        .update(schema.bookings)
        .set({ status: "REFUNDED", refundAmount: sql`${schema.bookings.refundAmount} + ${result.payment.amount}`, updatedAt: now })
        .where(and(eq(schema.bookings.id, result.booking.id), eq(schema.bookings.status, "CANCELLED")));
      notifyCancelled(result.booking.id, result.payment.amount);
    }
  }
  return { bookingCode: code, outcome: result.outcome };
}

export async function markPaymentFailed(orderId: string, raw: unknown, now = new Date()) {
  const db = await getDb();
  const [p] = await db
    .update(schema.payments)
    .set({ status: "FAILED", rawWebhookPayload: (raw ?? null) as never, updatedAt: now })
    .where(and(eq(schema.payments.providerOrderId, orderId), eq(schema.payments.status, "CREATED")))
    .returning();
  if (!p) return { updated: false };
  const d = await getBookingById(p.bookingId, db);
  if (d && d.booking.status === "PENDING_PAYMENT" && d.booking.holdExpiresAt && d.booking.holdExpiresAt > now) {
    const minutes = Math.max(1, Math.round((d.booking.holdExpiresAt.getTime() - now.getTime()) / 60_000));
    const id = await enqueueMessage(db, {
      phone: d.customer.phone,
      optedIn: d.customer.whatsappOptIn,
      bookingId: d.booking.id,
      template: "payment_failed_hold_expiring",
      params: { name: d.customer.name, code: d.booking.bookingCode, minutes: String(minutes), link: `${env.siteUrl}/booking/${d.booking.bookingCode}` },
      dedupeKey: `payment_failed:${d.booking.id}`,
    });
    dispatchInBackground([id]);
  }
  return { updated: true };
}

/** Store only what we need from a webhook (no email/contact/VPA/card details). [SEC-17] */
function minimalPayload(event: string, pay: { id?: string; order_id?: string; amount?: number } & Record<string, unknown>) {
  return { event, payment: { id: pay.id, order_id: pay.order_id, amount: pay.amount, status: pay.status, method: pay.method } };
}

/**
 * Counts webhook calls with a bad signature per clock hour; above 5 in an hour the owner gets one
 * alert for that hour (a wrong RAZORPAY_WEBHOOK_SECRET after a key rotation, or someone probing). [SEC-54]
 */
export const BAD_WEBHOOK_ALERT_AFTER = 5;
async function noteBadWebhookSignature(now = new Date()) {
  try {
    const hour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const n = await getCounterStore().incr(`webhook-badsig:${hour}`, new Date(hour + 3_600_000));
    if (n > BAD_WEBHOOK_ALERT_AFTER) {
      void alertOwner(`webhook_badsig_${hour}`, `More than ${BAD_WEBHOOK_ALERT_AFTER} Razorpay webhooks with a bad signature this hour (${n} so far). Check RAZORPAY_WEBHOOK_SECRET matches the Razorpay dashboard; paid bookings may not be confirming.`, now);
    }
  } catch (e) {
    console.warn("[webhook] could not count bad signature", e);
  }
}

/** Verifies and processes a Razorpay (or mock) webhook. Idempotent per event id. */
export async function handlePaymentWebhook(rawBody: string, signature: string | null, eventIdHeader: string | null) {
  const provider = getPaymentProvider();
  if (!signature || !provider.verifyWebhookSignature(rawBody, signature)) {
    await noteBadWebhookSignature();
    throw new AppError("INVALID_SIGNATURE", "Invalid webhook signature");
  }
  let body: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number } }; order?: { entity?: { id?: string } } };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new AppError("VALIDATION", "Invalid JSON");
  }
  const event = body.event ?? "unknown";
  const pay = body.payload?.payment?.entity;
  const eventId = eventIdHeader || `${event}:${pay?.id ?? body.payload?.order?.entity?.id ?? "?"}`;
  const db = await getDb();
  const [seen] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, eventId));
  if (seen) return { duplicate: true, event };

  let result: unknown = null;
  if ((event === "payment.captured" || event === "order.paid") && pay?.id && pay.order_id) {
    result = await confirmPayment({ orderId: pay.order_id, paymentId: pay.id, amountPaise: pay.amount, raw: minimalPayload(event, pay), via: "webhook" });
  } else if (event === "payment.failed" && pay?.order_id) {
    result = await markPaymentFailed(pay.order_id, minimalPayload(event, pay));
  }
  await db.insert(schema.webhookEvents).values({ id: eventId, type: event }).onConflictDoNothing();
  return { duplicate: false, event, result };
}

// ───────────────────────────── Refunds & cancellation ─────────────────────────────

const refundStatus = (refunded: unknown) => sql`case when ${refunded} >= ${schema.payments.amount} then 'REFUNDED' else 'PAID' end`;
const isOnline = (p: Pick<Payment, "provider">) => p.provider === "razorpay" || p.provider === "mock";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Give up automatic retries after this many failed attempts or this long, and ask the owner. [SEC-49] */
export const REFUND_GIVE_UP_ATTEMPTS = 20;
export const REFUND_GIVE_UP_MS = 24 * 3_600_000;
/** In-flight refunds younger than this are left alone: the provider call may still be running. */
export const REFUND_RECONCILE_AFTER_MS = 60_000;

/**
 * Refunds `amount` of one payment.
 * 1. Reserve: one atomic update adds the amount to `refundAmount` (only if it stays ≤ the payment
 *    amount) and, for gateway payments, stores a fresh refund key + amount + time — only if no other
 *    refund of this payment is in flight. So nothing can refund more than was paid (SEC-45), and two
 *    refunds of one payment never overlap.
 * 2. Call the provider with the key (Razorpay `receipt` and `notes.refund_key`).
 * 3. Success → clear the in-flight fields. Definite failure (4xx) → release the reservation.
 *    Unknown outcome (timeout, network, 5xx) → KEEP the reservation and key; the cron looks the
 *    refund up by key and either records it or releases it. A timeout is never retried blindly. [SEC-49]
 */
async function refundSinglePayment(p: Payment, amount: number, actor: string, now: Date) {
  if (amount <= 0) return 0;
  const db = await getDb();
  const provider = isOnline(p) ? getPaymentProvider() : null;
  const viaProvider = !!provider && p.provider === provider.name && !!p.providerPaymentId;
  const key = viaProvider ? `rf_${randomToken(12)}` : null;
  const [claimed] = await db
    .update(schema.payments)
    .set({
      refundAmount: sql`${schema.payments.refundAmount} + ${amount}`,
      status: refundStatus(sql`${schema.payments.refundAmount} + ${amount}`) as never,
      ...(key ? { refundInFlightKey: key, refundInFlightAmount: amount, refundInFlightAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(schema.payments.id, p.id), sql`${schema.payments.refundAmount} + ${amount} <= ${schema.payments.amount}`, isNull(schema.payments.refundInFlightKey)))
    .returning({ refundAmount: schema.payments.refundAmount });
  if (!claimed) {
    const [cur] = await db.select({ key: schema.payments.refundInFlightKey }).from(schema.payments).where(eq(schema.payments.id, p.id));
    if (cur?.key) throw new ProviderOutcomeUnknown("A refund for this payment is still being confirmed with the payment provider.");
    throw new AppError("NOT_ALLOWED", "This payment has already been refunded.");
  }
  let refundId: string;
  if (viaProvider && provider && key) {
    try {
      refundId = (await provider.refund({ paymentId: p.providerPaymentId!, amountRupees: amount, notes: { paymentId: p.id }, refundKey: key })).refundId;
    } catch (e) {
      if (e instanceof ProviderOutcomeUnknown) {
        await audit(db, { actor, action: "payment.refund_unknown", entity: "Payment", entityId: p.id, after: { amount, refundKey: key, error: errText(e) } });
        throw e;
      }
      await db
        .update(schema.payments)
        .set({
          refundAmount: sql`${schema.payments.refundAmount} - ${amount}`,
          status: refundStatus(sql`${schema.payments.refundAmount} - ${amount}`) as never,
          refundInFlightKey: null,
          refundInFlightAmount: 0,
          refundInFlightAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.payments.id, p.id), eq(schema.payments.refundInFlightKey, key)));
      throw e;
    }
  } else {
    // Cash/UPI handed back at the counter, or demo data paid through a different provider.
    refundId = isOnline(p) ? `manual_${p.provider}_${Date.now()}` : `manual_${p.provider.toLowerCase()}`;
  }
  await db
    .update(schema.payments)
    .set({ providerRefundId: refundId, refundedAt: now, refundInFlightKey: null, refundInFlightAmount: 0, refundInFlightAt: null })
    .where(eq(schema.payments.id, p.id));
  await audit(db, { actor, action: "payment.refund", entity: "Payment", entityId: p.id, before: { refundAmount: claimed.refundAmount - amount }, after: { refundAmount: claimed.refundAmount, refundId, refundKey: key } });
  return amount;
}

/**
 * Refunds up to `amount` across a booking's paid payments (online first). Never throws for a
 * provider failure: returns what was refunded and the first error, so callers can record the rest
 * as pending.
 */
async function tryRefundBooking(bookingId: string, amount: number, actor: string, now: Date): Promise<{ done: number; error?: string }> {
  const db = await getDb();
  const payments = await db.select().from(schema.payments).where(and(eq(schema.payments.bookingId, bookingId), inArray(schema.payments.status, ["PAID"])));
  payments.sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)));
  let left = amount;
  let done = 0;
  for (const p of payments) {
    if (left <= 0) break;
    const take = Math.min(left, p.amount - p.refundAmount);
    if (take <= 0) continue;
    try {
      done += await refundSinglePayment(p, take, actor, now);
      left -= take;
    } catch (e) {
      if (e instanceof AppError && e.code === "NOT_ALLOWED") continue; // refunded meanwhile by someone else
      return { done, error: errText(e) };
    }
  }
  return { done };
}

/** Refunds `amount` across a booking's paid payments (online first). Returns the amount refunded; throws on a provider failure. */
export async function refundBookingPayments(bookingId: string, amount: number, actor: string, now = new Date()) {
  const r = await tryRefundBooking(bookingId, amount, actor, now);
  if (r.error) throw new AppError("PROVIDER_ERROR", r.error);
  return r.done;
}

/**
 * A refund call failed or its outcome is unknown: remember the money still owed on the booking so
 * the cron reconciles/retries it, count the attempt, audit it, and tell the owner (one WhatsApp per
 * booking per day). [SEC-45][SEC-49]
 */
async function recordPendingRefund(bookingId: string, amount: number, actor: string, err: unknown, now: Date) {
  if (amount <= 0) return;
  const db = await getDb();
  const error = errText(err);
  const [b] = await db
    .update(schema.bookings)
    .set({
      refundPendingAmount: sql`${schema.bookings.refundPendingAmount} + ${amount}`,
      refundPendingSince: sql`coalesce(${schema.bookings.refundPendingSince}, ${now.toISOString()}::timestamptz)`,
      refundAttempts: sql`${schema.bookings.refundAttempts} + 1`,
      updatedAt: now,
    })
    .where(eq(schema.bookings.id, bookingId))
    .returning({ code: schema.bookings.bookingCode });
  await audit(db, { actor, action: "booking.refund_failed", entity: "Booking", entityId: bookingId, after: { amount, error } });
  console.warn(`[refund] ${formatINR(amount)} for ${b?.code ?? bookingId} failed: ${error}`);
  void alertOwner(`refund_failed_${bookingId}`, `Refund of ${formatINR(amount)} for booking ${b?.code ?? ""} failed. It is retried automatically every 15 minutes; check the payment dashboard if this repeats.`, now);
}

/** Booking-side bookkeeping once `amount` has really gone back to the customer. */
async function applyRefundToBooking(bookingId: string, amount: number, now: Date, opts: { fromPending: boolean }) {
  const db = await getDb();
  const [b] = await db
    .update(schema.bookings)
    .set({
      refundAmount: sql`${schema.bookings.refundAmount} + ${amount}`,
      ...(opts.fromPending ? { refundPendingAmount: sql`greatest(0, ${schema.bookings.refundPendingAmount} - ${amount})` } : {}),
      status: sql`case when ${schema.bookings.status} in ('CANCELLED', 'EXPIRED') then 'REFUNDED' else ${schema.bookings.status} end` as never,
      updatedAt: now,
    })
    .where(eq(schema.bookings.id, bookingId))
    .returning({ status: schema.bookings.status, pending: schema.bookings.refundPendingAmount });
  if (b && b.pending === 0) {
    await db.update(schema.bookings).set({ refundPendingSince: null, refundAttempts: 0 }).where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.refundPendingAmount, 0)));
  }
  if (b?.status === "REFUNDED") notifyCancelled(bookingId, amount, `refund:${bookingId}:${now.getTime()}`);
  return b;
}

/**
 * Cron step 1: settle refunds whose outcome was unknown. For each in-flight refund older than a
 * minute, list the payment's refunds at the provider and look for our key:
 * - found → the money went back: record it (the reservation stays, the booking is updated);
 * - not found → release the reservation; the booking's pending amount is then retried normally.
 * If the lookup itself fails, try again next run. [SEC-49]
 */
export async function reconcileInFlightRefunds(now = new Date()) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.payments)
    .where(and(isNotNull(schema.payments.refundInFlightKey), lte(schema.payments.refundInFlightAt, new Date(now.getTime() - REFUND_RECONCILE_AFTER_MS))))
    .limit(20);
  let settled = 0;
  for (const p of rows) {
    const provider = getPaymentProvider();
    if (p.provider !== provider.name || !p.providerPaymentId || !p.refundInFlightKey) continue;
    let found: ProviderRefund | undefined;
    try {
      found = (await provider.listRefunds(p.providerPaymentId)).find((r) => r.notes.refund_key === p.refundInFlightKey || r.receipt === p.refundInFlightKey);
    } catch (e) {
      console.warn(`[refund] lookup for payment ${p.id} failed, will retry: ${errText(e)}`);
      continue;
    }
    const amount = p.refundInFlightAmount;
    if (found) {
      const [done] = await db
        .update(schema.payments)
        .set({ providerRefundId: found.id, refundedAt: now, refundInFlightKey: null, refundInFlightAmount: 0, refundInFlightAt: null, updatedAt: now })
        .where(and(eq(schema.payments.id, p.id), eq(schema.payments.refundInFlightKey, p.refundInFlightKey)))
        .returning({ id: schema.payments.id });
      if (!done) continue;
      await audit(db, { actor: "system:refund-reconcile", action: "payment.refund_reconciled", entity: "Payment", entityId: p.id, after: { amount, refundId: found.id, refundKey: p.refundInFlightKey } });
      await applyRefundToBooking(p.bookingId, amount, now, { fromPending: true });
      settled += amount;
    } else {
      await db
        .update(schema.payments)
        .set({
          refundAmount: sql`${schema.payments.refundAmount} - ${amount}`,
          status: refundStatus(sql`${schema.payments.refundAmount} - ${amount}`) as never,
          refundInFlightKey: null,
          refundInFlightAmount: 0,
          refundInFlightAt: null,
          updatedAt: now,
        })
        .where(and(eq(schema.payments.id, p.id), eq(schema.payments.refundInFlightKey, p.refundInFlightKey)));
      await audit(db, { actor: "system:refund-reconcile", action: "payment.refund_not_found", entity: "Payment", entityId: p.id, after: { amount, refundKey: p.refundInFlightKey } });
    }
  }
  return settled;
}

/**
 * Cron step 2: retry pending refunds. Each booking's pending amount is claimed with a compare-and-set
 * (set to 0 only if unchanged), so overlapping cron runs can't both refund it. Whatever still fails
 * is put back and counted. After REFUND_GIVE_UP_ATTEMPTS failed attempts or REFUND_GIVE_UP_MS since
 * the first failure, the booking is marked "needs manual refund", retries stop, and the owner gets
 * one alert. [SEC-45][SEC-49]
 */
export async function retryPendingRefunds(now = new Date()) {
  const db = await getDb();
  const due = await db
    .select({ id: schema.bookings.id, pending: schema.bookings.refundPendingAmount, since: schema.bookings.refundPendingSince, attempts: schema.bookings.refundAttempts })
    .from(schema.bookings)
    .where(and(gt(schema.bookings.refundPendingAmount, 0), eq(schema.bookings.refundNeedsManual, false)))
    .limit(20);
  let refunded = 0;
  for (const row of due) {
    if (row.attempts >= REFUND_GIVE_UP_ATTEMPTS || (row.since && now.getTime() - row.since.getTime() >= REFUND_GIVE_UP_MS)) {
      const [gaveUp] = await db
        .update(schema.bookings)
        .set({ refundNeedsManual: true, updatedAt: now })
        .where(and(eq(schema.bookings.id, row.id), eq(schema.bookings.refundNeedsManual, false)))
        .returning({ code: schema.bookings.bookingCode });
      if (gaveUp) {
        await audit(db, { actor: "system:refund-retry", action: "booking.refund_needs_manual", entity: "Booking", entityId: row.id, after: { pending: row.pending, attempts: row.attempts } });
        void alertOwner(
          `refund_manual_${row.id}`,
          `Refund of ${formatINR(row.pending)} for booking ${gaveUp.code} could not be completed automatically (${row.attempts} attempts). Refund it from the Razorpay dashboard, then press "Mark refunded" under Refunds needing attention on the Overview page.`,
          now,
        );
      }
      continue;
    }
    const [claimed] = await db
      .update(schema.bookings)
      .set({ refundPendingAmount: 0, updatedAt: now })
      .where(and(eq(schema.bookings.id, row.id), eq(schema.bookings.refundPendingAmount, row.pending), eq(schema.bookings.refundNeedsManual, false)))
      .returning({ code: schema.bookings.bookingCode });
    if (!claimed) continue;
    const r = await tryRefundBooking(row.id, row.pending, "system:refund-retry", now);
    if (r.done > 0) {
      refunded += r.done;
      await audit(db, { actor: "system:refund-retry", action: "booking.refund_retried", entity: "Booking", entityId: row.id, after: { refunded: r.done } });
      await applyRefundToBooking(row.id, r.done, now, { fromPending: false });
    }
    // Put back what is still owed. If nothing refundable is left (refunded by hand meanwhile), drop it.
    const left = r.error ? row.pending - r.done : 0;
    if (left > 0) {
      await db
        .update(schema.bookings)
        .set({ refundPendingAmount: sql`${schema.bookings.refundPendingAmount} + ${left}`, refundAttempts: sql`${schema.bookings.refundAttempts} + 1` })
        .where(eq(schema.bookings.id, row.id));
      console.warn(`[refund] retry for ${claimed.code} failed: ${r.error}`);
      void alertOwner(`refund_failed_${row.id}`, `Refund of ${formatINR(left)} for booking ${claimed.code} is still failing. Check the payment dashboard.`, now);
    } else {
      await db.update(schema.bookings).set({ refundPendingSince: null, refundAttempts: 0 }).where(and(eq(schema.bookings.id, row.id), eq(schema.bookings.refundPendingAmount, 0)));
    }
  }
  return refunded;
}

/** Bookings whose refund gave up retrying — shown on the Overview "Refunds needing attention" card. */
export async function refundsNeedingAttention() {
  const db = await getDb();
  return db
    .select({
      id: schema.bookings.id,
      bookingCode: schema.bookings.bookingCode,
      pending: schema.bookings.refundPendingAmount,
      since: schema.bookings.refundPendingSince,
      attempts: schema.bookings.refundAttempts,
      name: schema.customers.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .where(and(eq(schema.bookings.refundNeedsManual, true), gt(schema.bookings.refundPendingAmount, 0)))
    .orderBy(schema.bookings.refundPendingSince);
}

/**
 * Owner: "I refunded this from the Razorpay dashboard." Records the pending amount as refunded
 * (payments marked `manual_owner`), clears the give-up state, audits it and tells the customer.
 * Refused while a refund is still in flight (its outcome isn't known yet). [SEC-49]
 */
export async function markRefundedManually(bookingId: string, actor: string, now = new Date()) {
  const db = await getDb();
  const d = await getBookingById(bookingId, db);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
  const amount = d.booking.refundPendingAmount;
  if (amount <= 0) throw new AppError("NOT_ALLOWED", "There is no pending refund on this booking.");
  if (d.payments.some((p) => p.refundInFlightKey)) throw new AppError("NOT_ALLOWED", "A refund is still being checked with the payment provider. Try again after the next automatic run (15 minutes).");
  const [claimed] = await db
    .update(schema.bookings)
    .set({ refundPendingAmount: 0, refundNeedsManual: false, refundPendingSince: null, refundAttempts: 0, updatedAt: now })
    .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.refundPendingAmount, amount)))
    .returning({ id: schema.bookings.id });
  if (!claimed) throw new AppError("NOT_ALLOWED", "This refund changed meanwhile. Refresh and try again.");
  let left = amount;
  const paid = d.payments.filter((p) => p.status === "PAID").sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)));
  for (const p of paid) {
    if (left <= 0) break;
    const take = Math.min(left, p.amount - p.refundAmount);
    if (take <= 0) continue;
    const [ok] = await db
      .update(schema.payments)
      .set({ refundAmount: sql`${schema.payments.refundAmount} + ${take}`, status: refundStatus(sql`${schema.payments.refundAmount} + ${take}`) as never, providerRefundId: "manual_owner", refundedAt: now, updatedAt: now })
      .where(and(eq(schema.payments.id, p.id), sql`${schema.payments.refundAmount} + ${take} <= ${schema.payments.amount}`, isNull(schema.payments.refundInFlightKey)))
      .returning({ id: schema.payments.id });
    if (ok) left -= take;
  }
  const recorded = amount - left;
  await audit(db, { actor, action: "booking.refund_marked_manual", entity: "Booking", entityId: bookingId, after: { amount: recorded } });
  await applyRefundToBooking(bookingId, recorded, now, { fromPending: false });
  return recorded;
}

export type CancelRefund = { mode: "POLICY" } | { mode: "FULL" } | { mode: "NONE" } | { mode: "PARTIAL"; amount: number };

export async function previewCustomerRefund(code: string, now = new Date()) {
  const d = await getBookingByCode(code);
  if (!d) return null;
  const s = await getSettings();
  const paid = netPaid(d.payments);
  return {
    paid,
    refund: refundFor(s, { startAt: d.booking.startAt, now, paidAmount: paid }),
    canCancel: canCancelOnline(s, d.booking.startAt, now),
    policy: policySummary(s),
  };
}

export async function cancelBooking(
  input: { bookingId: string; actor: string; by: "CUSTOMER" | "ADMIN"; refund: CancelRefund; reason?: string; freshOtp?: boolean },
  now = new Date(),
): Promise<{ status: Booking["status"]; refunded: number; refundError?: string }> {
  const db = await getDb();
  const settings = await getSettings(db);
  const { booking, refundDue } = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, input.bookingId)).for("update");
    if (!b) throw new AppError("NOT_FOUND", "Booking not found.");
    if (b.status !== "CONFIRMED" && b.status !== "PENDING_PAYMENT") throw new AppError("NOT_ALLOWED", `A ${b.status.toLowerCase().replace("_", " ")} booking can't be cancelled.`);
    if (input.by === "CUSTOMER" && !canCancelOnline(settings, b.startAt, now)) {
      throw new AppError(
        "NOT_ALLOWED",
        settings.cancelCutoffHours > 0
          ? `Online cancelling closes ${hoursText(settings.cancelCutoffHours)} before the slot. Please call the venue.`
          : "This slot has already started and can't be cancelled online.",
      );
    }
    const payments = await tx.select().from(schema.payments).where(eq(schema.payments.bookingId, b.id));
    const paid = netPaid(payments);
    let due = 0;
    switch (input.refund.mode) {
      case "POLICY":
        due = refundFor(settings, { startAt: b.startAt, now, paidAmount: paid });
        break;
      case "FULL":
        due = paid;
        break;
      case "PARTIAL":
        if (input.refund.amount < 0 || input.refund.amount > paid) throw new AppError("VALIDATION", `Refund must be between ₹0 and ${formatINR(paid)}.`);
        due = input.refund.amount;
        break;
      case "NONE":
        due = 0;
    }
    // Money back needs a code typed just now, even on a remembered device. Checked here, inside the
    // locked transaction, so it uses the same refund figure that will be paid. [SEC-43]
    if (input.by === "CUSTOMER" && due > 0 && !input.freshOtp) {
      throw new AppError("FRESH_OTP_REQUIRED", "For your safety, confirm with a new code sent to your phone before we refund.");
    }
    const [updated] = await tx
      .update(schema.bookings)
      .set({ status: "CANCELLED", cancelledAt: now, cancelReason: input.reason?.slice(0, 300) || (input.by === "CUSTOMER" ? "Cancelled by customer" : "Cancelled by venue"), holdExpiresAt: null, updatedAt: now })
      .where(eq(schema.bookings.id, b.id))
      .returning();
    await audit(tx, { actor: input.actor, action: "booking.cancel", entity: "Booking", entityId: b.id, before: { status: b.status }, after: { status: "CANCELLED", refundDue: due, mode: input.refund.mode } });
    return { booking: updated, refundDue: due };
  });
  await invalidateAvailability(booking.courtId, booking.startAt);

  let refunded = 0;
  let refundError: string | undefined;
  if (refundDue > 0) {
    const r = await tryRefundBooking(booking.id, refundDue, input.actor, now);
    refunded = r.done;
    if (refunded > 0) {
      await db.update(schema.bookings).set({ status: "REFUNDED", refundAmount: booking.refundAmount + refunded, updatedAt: now }).where(eq(schema.bookings.id, booking.id));
    }
    if (r.error) {
      refundError = r.error;
      await recordPendingRefund(booking.id, refundDue - refunded, input.actor, r.error, now);
    }
  }
  if (booking.advanceAmount > 0 || booking.source !== "ONLINE" || refunded > 0) notifyCancelled(booking.id, refunded);
  return { status: refunded > 0 ? "REFUNDED" : "CANCELLED", refunded, refundError };
}

/** Admin refund for a booking that is already cancelled/expired but still holds money (e.g. a failed auto-refund). */
export async function refundCancelledBooking(bookingId: string, amount: number, actor: string, now = new Date()) {
  const d = await getBookingById(bookingId);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found.");
  if (!["CANCELLED", "EXPIRED", "REFUNDED", "NO_SHOW"].includes(d.booking.status)) throw new AppError("NOT_ALLOWED", "Cancel the booking first.");
  const paid = netPaid(d.payments);
  if (amount <= 0 || amount > paid) throw new AppError("VALIDATION", `Refund must be between ₹1 and ${formatINR(paid)}.`);
  const r = await tryRefundBooking(bookingId, amount, actor, now);
  const refunded = r.done;
  const db = await getDb();
  if (r.error && refunded === 0) throw new AppError("PROVIDER_ERROR", `Refund failed: ${r.error}`);
  // A manual refund also settles any automatic retry still pending for this booking. [SEC-45]
  await db
    .update(schema.bookings)
    .set({
      status: d.booking.status === "NO_SHOW" ? "NO_SHOW" : "REFUNDED",
      refundAmount: sql`${schema.bookings.refundAmount} + ${refunded}`,
      refundPendingAmount: sql`greatest(0, ${schema.bookings.refundPendingAmount} - ${refunded})`,
      updatedAt: now,
    })
    .where(eq(schema.bookings.id, bookingId));
  notifyCancelled(bookingId, refunded, `refund:${bookingId}:${now.getTime()}`);
  return refunded;
}

// ───────────────────────────── Admin bookings ─────────────────────────────

export async function createAdminBooking(
  input: {
    courtId: string;
    date: string;
    times: string[];
    name: string;
    phone: string;
    whatsappOptIn: boolean;
    source: Exclude<BookingSource, "ONLINE">;
    amountReceived: number;
    paymentMode: "CASH" | "UPI" | "CARD";
    notes?: string;
  },
  actor: string,
  now = new Date(),
) {
  const db = await getDb();
  const avail = await loadAvailability(db, input.courtId, input.date, now, { admin: true });
  const pick = selectionError(avail.slots, input.times);
  const total = pick.slots.reduce((s, x) => s + x.price, 0);
  if (input.amountReceived > total) throw new AppError("VALIDATION", `Amount received can't exceed the total of ${formatINR(total)}.`);
  const startAt = new Date(pick.slots[0].startAt);
  const endAt = new Date(pick.slots[pick.slots.length - 1].endAt);
  try {
    const booking = await transactionWithRetry(db, async (tx) => {
      const customer = await upsertCustomer(tx, input.phone, input.name, input.whatsappOptIn || undefined, now);
      await lockCourtDay(tx, input.courtId, input.date);
      await assertNotBlocked(tx, input.courtId, startAt, endAt);
      await expireStaleOverlapping(tx, input.courtId, startAt, endAt, now);
      const [b] = await tx
        .insert(schema.bookings)
        .values({
          bookingCode: newBookingCode(),
          customerId: customer.id,
          courtId: input.courtId,
          startAt,
          endAt,
          status: "CONFIRMED",
          totalAmount: total,
          advanceAmount: input.amountReceived,
          balanceAmount: total - input.amountReceived,
          balancePaidAt: input.amountReceived === total ? now : null,
          source: input.source,
          notes: input.notes || null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (input.amountReceived > 0) {
        await tx.insert(schema.payments).values({ bookingId: b.id, provider: input.paymentMode, kind: "ADVANCE", amount: input.amountReceived, status: "PAID", paidAt: now });
      }
      await audit(tx, { actor, action: "booking.create_admin", entity: "Booking", entityId: b.id, after: { code: b.bookingCode, source: b.source, total, received: input.amountReceived } });
      return b;
    });
    await invalidateAvailability(booking.courtId, booking.startAt);
    notifyConfirmed(booking.id);
    return booking;
  } catch (e) {
    if (isConstraint(e, PG_EXCLUSION_VIOLATION)) throw new AppError("SLOT_TAKEN", "That slot overlaps an existing booking.");
    throw e;
  }
}

export async function markBalancePaid(bookingId: string, mode: "CASH" | "UPI" | "CARD", actor: string, now = new Date()) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).for("update");
    if (!b) throw new AppError("NOT_FOUND", "Booking not found.");
    if (!["CONFIRMED", "COMPLETED"].includes(b.status)) throw new AppError("NOT_ALLOWED", "Only confirmed or completed bookings can take a balance payment.");
    if (b.balancePaidAt || b.balanceAmount === 0) throw new AppError("NOT_ALLOWED", "The balance is already settled.");
    await tx.insert(schema.payments).values({ bookingId: b.id, provider: mode, kind: "BALANCE", amount: b.balanceAmount, status: "PAID", paidAt: now });
    await tx.update(schema.bookings).set({ balancePaidAt: now, updatedAt: now }).where(eq(schema.bookings.id, b.id));
    await audit(tx, { actor, action: "booking.balance_paid", entity: "Booking", entityId: b.id, after: { amount: b.balanceAmount, mode } });
  });
}

export async function setBookingOutcome(bookingId: string, outcome: "COMPLETED" | "NO_SHOW", actor: string, now = new Date()) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).for("update");
    if (!b) throw new AppError("NOT_FOUND", "Booking not found.");
    if (!["CONFIRMED", "COMPLETED", "NO_SHOW"].includes(b.status)) throw new AppError("NOT_ALLOWED", "Only confirmed bookings can be marked completed or no-show.");
    if (b.startAt.getTime() > now.getTime()) throw new AppError("NOT_ALLOWED", "You can mark this after the slot starts.");
    await tx.update(schema.bookings).set({ status: outcome, updatedAt: now }).where(eq(schema.bookings.id, b.id));
    await audit(tx, { actor, action: `booking.${outcome.toLowerCase()}`, entity: "Booking", entityId: b.id, before: { status: b.status }, after: { status: outcome } });
    if (outcome === "NO_SHOW") {
      // Auto-block a number after N no-shows (Settings.noShowBlockThreshold, 0 = off). [SEC-12]
      const settings = await getSettings(tx);
      if (settings.noShowBlockThreshold > 0) {
        const [{ n }] = await tx
          .select({ n: count() })
          .from(schema.bookings)
          .where(and(eq(schema.bookings.customerId, b.customerId), eq(schema.bookings.status, "NO_SHOW")));
        if (n >= settings.noShowBlockThreshold) {
          const blocked = await tx
            .update(schema.customers)
            .set({ isBlocked: true, blockedAt: now, blockedReason: `${n} no-shows`, trustEpoch: sql`${schema.customers.trustEpoch} + 1` })
            .where(and(eq(schema.customers.id, b.customerId), eq(schema.customers.isBlocked, false)))
            .returning({ id: schema.customers.id });
          if (blocked.length) await audit(tx, { actor: "system", action: "customer.auto_block", entity: "Customer", entityId: b.customerId, after: { noShows: n } });
        }
      }
    }
  });
}

// ───────────────────────────── Blocks ─────────────────────────────

export async function createBlocks(
  input: { courtId: string; ranges: { startAt: Date; endAt: Date }[]; reason: "MAINTENANCE" | "TOURNAMENT" | "PRIVATE_EVENT" | "OTHER"; note?: string; recurrenceGroupId?: string },
  actor: string,
  now = new Date(),
) {
  const db = await getDb();
  const created = await db.transaction(async (tx) => {
    // Same court-day locks as holds and walk-ins (sorted, so two block requests can't deadlock), so a
    // booking can't slip in between the overlap check below and the insert. [SEC-47]
    const days = new Set<string>();
    for (const r of input.ranges) {
      days.add(istDateKey(r.startAt));
      days.add(istDateKey(new Date(r.endAt.getTime() - 1)));
    }
    for (const day of [...days].sort()) await lockCourtDay(tx, input.courtId, day);
    const conflicts: string[] = [];
    for (const r of input.ranges) {
      if (r.endAt <= r.startAt) throw new AppError("VALIDATION", "End time must be after start time.");
      const hits = await tx
        .select({ code: schema.bookings.bookingCode })
        .from(schema.bookings)
        .where(
          and(
            eq(schema.bookings.courtId, input.courtId),
            lt(schema.bookings.startAt, r.endAt),
            gt(schema.bookings.endAt, r.startAt),
            // Typed comparison (not a raw Date in sql``): postgres-js rejects Date parameters in raw SQL. [SEC-47]
            or(eq(schema.bookings.status, "CONFIRMED"), and(eq(schema.bookings.status, "PENDING_PAYMENT"), gt(schema.bookings.holdExpiresAt, now))),
          ),
        );
      conflicts.push(...hits.map((h) => h.code));
    }
    if (conflicts.length) throw new AppError("NOT_ALLOWED", `Can't block: overlaps booking${conflicts.length > 1 ? "s" : ""} ${[...new Set(conflicts)].join(", ")}. Cancel ${conflicts.length > 1 ? "them" : "it"} first.`);
    const rows = await tx
      .insert(schema.blockedSlots)
      .values(input.ranges.map((r) => ({ courtId: input.courtId, startAt: r.startAt, endAt: r.endAt, reason: input.reason, note: input.note || null, recurrenceGroupId: input.recurrenceGroupId ?? null, createdBy: actor })))
      .returning();
    await audit(tx, { actor, action: "block.create", entity: "BlockedSlot", entityId: rows[0]?.id, after: { courtId: input.courtId, count: rows.length, reason: input.reason, recurrenceGroupId: input.recurrenceGroupId ?? null } });
    return rows;
  });
  for (const r of created) await invalidateAvailability(r.courtId, r.startAt);
  return created;
}

// ───────────────────────────── Crons ─────────────────────────────

export async function expireHolds(now = new Date()) {
  const db = await getDb();
  const rows = await db
    .update(schema.bookings)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(eq(schema.bookings.status, "PENDING_PAYMENT"), lte(schema.bookings.holdExpiresAt, now)))
    .returning({ id: schema.bookings.id, courtId: schema.bookings.courtId, startAt: schema.bookings.startAt });
  for (const r of rows) await invalidateAvailability(r.courtId, r.startAt);
  return rows.length;
}

export async function sendReminders(now = new Date()) {
  const db = await getDb();
  const due = await db
    .update(schema.bookings)
    .set({ reminderSentAt: now })
    .where(
      and(
        eq(schema.bookings.status, "CONFIRMED"),
        isNull(schema.bookings.reminderSentAt),
        gt(schema.bookings.startAt, now),
        lte(schema.bookings.startAt, new Date(now.getTime() + 2 * 3_600_000)),
      ),
    )
    .returning({ id: schema.bookings.id });
  const ids: (string | null)[] = [];
  for (const { id } of due) {
    const d = await getBookingById(id, db);
    if (!d) continue;
    ids.push(
      await enqueueMessage(db, {
        phone: d.customer.phone,
        optedIn: d.customer.whatsappOptIn,
        bookingId: id,
        template: "booking_reminder",
        params: {
          name: d.customer.name,
          sport: siteConfig.sports[d.sport].label,
          court: d.courtName,
          time: formatTime(d.booking.startAt),
          code: d.booking.bookingCode,
          map: siteConfig.directionsUrl,
        },
        dedupeKey: `booking_reminder:${id}`,
      }),
    );
  }
  dispatchInBackground(ids);
  return due.length;
}

// ───────────────────────────── Notifications ─────────────────────────────

/** Queue confirmation (customer, if opted in) + owner alert. Never throws. */
export function notifyConfirmed(bookingId: string, opts: { resend?: boolean } = {}) {
  runInBackground(async () => {
    try {
      const db = await getDb();
      const d = await getBookingById(bookingId, db);
      if (!d) return;
      const settings = await getSettings(db);
      const b = d.booking;
      const when = formatTimeRange(b.startAt, b.endAt);
      const suffix = opts.resend ? `:resend:${Date.now()}` : "";
      const ids = [
        await enqueueMessage(db, {
          phone: d.customer.phone,
          optedIn: d.customer.whatsappOptIn,
          bookingId,
          template: "booking_confirmed",
          params: {
            name: d.customer.name,
            sport: siteConfig.sports[d.sport].label,
            court: d.courtName,
            date: formatDate(b.startAt),
            time: when,
            code: b.bookingCode,
            advance: formatINR(netPaid(d.payments)),
            balance: formatINR(b.balancePaidAt ? 0 : b.balanceAmount),
            map: siteConfig.directionsUrl,
            policy: policySummary(settings),
          },
          dedupeKey: `booking_confirmed:${bookingId}${suffix}`,
        }),
      ];
      if (!opts.resend && settings.ownerAlertPhone) {
        ids.push(
          await enqueueMessage(db, {
            phone: settings.ownerAlertPhone,
            optedIn: true,
            bookingId,
            template: "admin_new_booking",
            params: {
              code: b.bookingCode,
              name: d.customer.name,
              phone: d.customer.phone,
              court: d.courtName,
              date: formatDate(b.startAt),
              time: when,
              amount: formatINR(netPaid(d.payments)),
              source: b.source,
            },
            dedupeKey: `admin_new_booking:${bookingId}`,
          }),
        );
      }
      for (const id of ids) if (id) await dispatchMessage(id);
    } catch (e) {
      console.error("[notify] confirmed failed", e);
    }
  });
}

export function notifyCancelled(bookingId: string, refund: number, dedupe?: string) {
  runInBackground(async () => {
    try {
      const db = await getDb();
      const d = await getBookingById(bookingId, db);
      if (!d) return;
      const id = await enqueueMessage(db, {
        phone: d.customer.phone,
        optedIn: d.customer.whatsappOptIn,
        bookingId,
        template: "booking_cancelled",
        params: {
          name: d.customer.name,
          code: d.booking.bookingCode,
          date: formatDate(d.booking.startAt),
          time: formatTimeRange(d.booking.startAt, d.booking.endAt),
          refund: cancelledRefundText(await getSettings(db), refund, formatINR(refund)),
        },
        dedupeKey: dedupe ?? `booking_cancelled:${bookingId}`,
      });
      if (id) await dispatchMessage(id);
    } catch (e) {
      console.error("[notify] cancelled failed", e);
    }
  });
}

/** Bookings for a verified phone, newest first. */
export async function bookingsForPhone(phone: string) {
  const db = await getDb();
  return db
    .select({
      bookingCode: schema.bookings.bookingCode,
      startAt: schema.bookings.startAt,
      endAt: schema.bookings.endAt,
      status: schema.bookings.status,
      totalAmount: schema.bookings.totalAmount,
      advanceAmount: schema.bookings.advanceAmount,
      courtName: schema.courts.name,
      sport: schema.sports.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
    .innerJoin(schema.sports, eq(schema.courts.sportId, schema.sports.id))
    .where(and(eq(schema.customers.phone, phone), inArray(schema.bookings.status, ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "REFUNDED", "NO_SHOW", "EXPIRED"])))
    .orderBy(desc(schema.bookings.startAt))
    .limit(100);
}

