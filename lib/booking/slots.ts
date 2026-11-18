/** Pure slot generation: turns hours + rules + existing bookings/blocks into a slot grid. */
import { addDays, daysBetween, istDateKey, istToUtc, minutesToHHMM, timeToMinutes, formatMinutes } from "@/lib/time";
import { priceForSlot, type PricingRuleLite } from "@/lib/pricing";
import type { BookingStatus, DayType } from "@/db/schema";

export type SlotState = "AVAILABLE" | "BOOKED" | "BLOCKED" | "PAST";

export type Slot = {
  time: string; // "18:00" IST
  label: string; // "6:00 PM"
  endLabel: string;
  startAt: string; // ISO UTC
  endAt: string;
  price: number;
  state: SlotState;
};

export type HoursLite = { openTime: string; closeTime: string; isClosed: boolean } | null;
export type Interval = { startAt: Date; endAt: Date };
export type BookingLite = Interval & { status: BookingStatus; holdExpiresAt: Date | null };

/** Does this booking currently occupy its time range? Expired holds are free even before the cron runs. */
export function isBookingActive(b: Pick<BookingLite, "status" | "holdExpiresAt">, now: Date): boolean {
  if (b.status === "CONFIRMED" || b.status === "COMPLETED" || b.status === "NO_SHOW") return true;
  if (b.status === "PENDING_PAYMENT") return !!b.holdExpiresAt && b.holdExpiresAt.getTime() > now.getTime();
  return false;
}

const overlaps = (aStart: number, aEnd: number, b: Interval) => aStart < b.endAt.getTime() && b.startAt.getTime() < aEnd;

/** Bookable date keys (today … today + maxDaysAhead - 1), in IST. */
export function bookableDates(now: Date, maxDaysAhead: number): string[] {
  const today = istDateKey(now);
  return Array.from({ length: maxDaysAhead }, (_, i) => addDays(today, i));
}

export function isDateBookable(dateKey: string, now: Date, maxDaysAhead: number): boolean {
  const diff = daysBetween(istDateKey(now), dateKey);
  return diff >= 0 && diff < maxDaysAhead;
}

export function generateSlots(input: {
  dateKey: string;
  hours: HoursLite;
  slotMinutes: number;
  rules: readonly PricingRuleLite[];
  dayType: DayType;
  now: Date;
  blocks: readonly Interval[];
  bookings: readonly BookingLite[];
  /** Admin walk-ins may book a slot that has started but not ended. */
  allowStarted?: boolean;
}): Slot[] {
  const { dateKey, hours, slotMinutes, rules, dayType, now, blocks, bookings } = input;
  if (!hours || hours.isClosed) return [];
  const open = timeToMinutes(hours.openTime);
  const close = timeToMinutes(hours.closeTime);
  const active = bookings.filter((b) => isBookingActive(b, now));
  const slots: Slot[] = [];
  for (let m = open; m + slotMinutes <= close; m += slotMinutes) {
    const start = istToUtc(dateKey, m);
    const end = istToUtc(dateKey, m + slotMinutes);
    const s = start.getTime();
    const e = end.getTime();
    const price = priceForSlot(rules, dayType, m);
    let state: SlotState = "AVAILABLE";
    const isPast = input.allowStarted ? e <= now.getTime() : s <= now.getTime();
    if (isPast) state = "PAST";
    else if (blocks.some((b) => overlaps(s, e, b))) state = "BLOCKED";
    else if (active.some((b) => overlaps(s, e, b))) state = "BOOKED";
    else if (price === null) state = "BLOCKED"; // no price configured → not bookable
    slots.push({
      time: minutesToHHMM(m),
      label: formatMinutes(m),
      endLabel: formatMinutes(m + slotMinutes),
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      price: price ?? 0,
      state,
    });
  }
  return slots;
}

/**
 * Validates a client's slot selection against a freshly generated grid: every slot must exist,
 * be AVAILABLE, and the set must be consecutive. Returns the slots in order, or an error code.
 */
export function pickConsecutive(slots: readonly Slot[], times: readonly string[]):
  | { ok: true; slots: Slot[] }
  | { ok: false; error: "EMPTY" | "UNKNOWN_SLOT" | "NOT_CONSECUTIVE" | "UNAVAILABLE"; time?: string } {
  if (times.length === 0) return { ok: false, error: "EMPTY" };
  const unique = Array.from(new Set(times));
  const picked: { idx: number; slot: Slot }[] = [];
  for (const t of unique) {
    const idx = slots.findIndex((s) => s.time === t);
    if (idx === -1) return { ok: false, error: "UNKNOWN_SLOT", time: t };
    picked.push({ idx, slot: slots[idx] });
  }
  picked.sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < picked.length; i++) {
    if (picked[i].idx !== picked[i - 1].idx + 1) return { ok: false, error: "NOT_CONSECUTIVE" };
  }
  const bad = picked.find((p) => p.slot.state !== "AVAILABLE");
  if (bad) return { ok: false, error: "UNAVAILABLE", time: bad.slot.time };
  return { ok: true, slots: picked.map((p) => p.slot) };
}
