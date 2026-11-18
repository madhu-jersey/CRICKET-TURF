/** Pure pricing logic. The server is the only place prices are computed. */
import { dayOfWeek, timeToMinutes } from "@/lib/time";
import type { DayType } from "@/db/schema";

export type PricingRuleLite = { dayType: DayType; startTime: string; endTime: string; pricePerSlot: number };
export type AdvanceSettings = { advanceType: "FIXED" | "PERCENT"; advanceValue: number };

export function getDayType(dateKey: string, holidayKeys: ReadonlySet<string>): DayType {
  if (holidayKeys.has(dateKey)) return "HOLIDAY";
  const dow = dayOfWeek(dateKey);
  return dow === 0 || dow === 6 ? "WEEKEND" : "WEEKDAY";
}

/**
 * Price of the slot starting at `startMinutes` (IST). A rule matches if
 * startTime <= slot start < endTime. Holidays fall back to weekend rules, weekends to weekday
 * rules, so the owner only has to configure what differs. Returns null if no rule covers it.
 */
export function priceForSlot(rules: readonly PricingRuleLite[], dayType: DayType, startMinutes: number): number | null {
  const chain: DayType[] = dayType === "HOLIDAY" ? ["HOLIDAY", "WEEKEND", "WEEKDAY"] : dayType === "WEEKEND" ? ["WEEKEND", "WEEKDAY"] : ["WEEKDAY"];
  for (const dt of chain) {
    const match = rules.find(
      (r) => r.dayType === dt && timeToMinutes(r.startTime) <= startMinutes && startMinutes < timeToMinutes(r.endTime),
    );
    if (match) return match.pricePerSlot;
  }
  return null;
}

export function computeAdvance(total: number, s: AdvanceSettings): number {
  if (total <= 0) return 0;
  const raw = s.advanceType === "FIXED" ? s.advanceValue : Math.round((total * s.advanceValue) / 100);
  return Math.max(0, Math.min(total, raw));
}

/** Discount in whole rupees for a percent off (rounded down, so we never over-discount). */
export function discountFor(subtotal: number, percent: number): number {
  if (subtotal <= 0 || percent <= 0) return 0;
  return Math.min(subtotal, Math.floor((subtotal * percent) / 100));
}

/**
 * subtotal = sum of slot prices; discount (e.g. first-booking offer) comes off before the
 * advance is calculated, so the customer pays the advance on the discounted total.
 */
export function priceBreakdown(slotPrices: readonly number[], s: AdvanceSettings, discountPercent = 0) {
  const subtotal = slotPrices.reduce((a, b) => a + b, 0);
  const discount = discountFor(subtotal, discountPercent);
  const total = subtotal - discount;
  const advance = computeAdvance(total, s);
  return { subtotal, discount, total, advance, balance: total - advance };
}

export function formatINR(amount: number): string {
  return "₹" + amount.toLocaleString("en-IN");
}
