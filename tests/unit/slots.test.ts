import { describe, expect, it } from "vitest";
import { bookableDates, generateSlots, isBookingActive, pickConsecutive } from "@/lib/booking/slots";
import { canCancelOnline, refundFor } from "@/lib/policy";
import { addDays, istDateKey, istToUtc, istTimeHHMM, formatMinutes } from "@/lib/time";
import type { PricingRuleLite } from "@/lib/pricing";

const rules: PricingRuleLite[] = [
  { dayType: "WEEKDAY", startTime: "06:00", endTime: "18:00", pricePerSlot: 400 },
  { dayType: "WEEKDAY", startTime: "18:00", endTime: "24:00", pricePerSlot: 600 },
];
const hours = { openTime: "06:00", closeTime: "23:00", isClosed: false };
const base = { slotMinutes: 60, rules, dayType: "WEEKDAY" as const, blocks: [], bookings: [] };

describe("IST/UTC conversion", () => {
  it("maps IST wall time to UTC", () => {
    expect(istToUtc("2026-11-18", "06:00").toISOString()).toBe("2026-11-18T00:30:00.000Z");
    expect(istToUtc("2026-11-18", "00:00").toISOString()).toBe("2026-11-17T18:30:00.000Z");
    expect(istToUtc("2026-11-18", "24:00").toISOString()).toBe("2026-11-18T18:30:00.000Z");
  });
  it("computes the IST date around midnight correctly", () => {
    // 18:29 UTC on the 17th is 23:59 IST on the 17th; 18:30 UTC is 00:00 IST on the 18th.
    expect(istDateKey(new Date("2026-11-17T18:29:00Z"))).toBe("2026-11-17");
    expect(istDateKey(new Date("2026-11-17T18:30:00Z"))).toBe("2026-11-18");
    expect(istTimeHHMM(new Date("2026-11-17T18:45:00Z"))).toBe("00:15");
  });
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });
  it("formats labels", () => {
    expect(formatMinutes(0)).toBe("12:00 AM");
    expect(formatMinutes(18 * 60)).toBe("6:00 PM");
  });
});

describe("generateSlots", () => {
  it("respects operating hours", () => {
    const slots = generateSlots({ ...base, dateKey: "2026-11-20", hours, now: new Date("2026-11-01T00:00:00Z") });
    expect(slots).toHaveLength(17); // 6 AM … 10 PM starts
    expect(slots[0].time).toBe("06:00");
    expect(slots.at(-1)!.time).toBe("22:00");
    expect(slots.every((s) => s.state === "AVAILABLE")).toBe(true);
    expect(slots.find((s) => s.time === "18:00")!.price).toBe(600);
  });
  it("returns no slots when closed", () => {
    expect(generateSlots({ ...base, dateKey: "2026-11-20", hours: { ...hours, isClosed: true }, now: new Date(0) })).toEqual([]);
  });
  it("hides past slots for today (IST), including just after midnight IST", () => {
    // 10:15 IST
    const now = istToUtc("2026-11-20", "10:15");
    const slots = generateSlots({ ...base, dateKey: "2026-11-20", hours, now });
    expect(slots.filter((s) => s.state === "PAST").map((s) => s.time)).toEqual(["06:00", "07:00", "08:00", "09:00", "10:00"]);
    expect(slots.find((s) => s.time === "11:00")!.state).toBe("AVAILABLE");
    // 00:30 IST on the 21st is still the 20th in UTC; the whole 21st must be available.
    const lateNow = new Date("2026-11-20T19:00:00Z");
    expect(istDateKey(lateNow)).toBe("2026-11-21");
    const next = generateSlots({ ...base, dateKey: "2026-11-21", hours, now: lateNow });
    expect(next.every((s) => s.state === "AVAILABLE")).toBe(true);
  });
  it("marks blocked and booked slots, and frees expired holds", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const slots = generateSlots({
      ...base,
      dateKey: "2026-11-20",
      hours,
      now,
      blocks: [{ startAt: istToUtc("2026-11-20", "06:00"), endAt: istToUtc("2026-11-20", "08:00") }],
      bookings: [
        { startAt: istToUtc("2026-11-20", "18:00"), endAt: istToUtc("2026-11-20", "20:00"), status: "CONFIRMED", holdExpiresAt: null },
        { startAt: istToUtc("2026-11-20", "21:00"), endAt: istToUtc("2026-11-20", "22:00"), status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 60_000) },
        { startAt: istToUtc("2026-11-20", "22:00"), endAt: istToUtc("2026-11-20", "23:00"), status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() - 1) },
        { startAt: istToUtc("2026-11-20", "10:00"), endAt: istToUtc("2026-11-20", "11:00"), status: "CANCELLED", holdExpiresAt: null },
      ],
    });
    const st = (t: string) => slots.find((s) => s.time === t)!.state;
    expect(st("06:00")).toBe("BLOCKED");
    expect(st("07:00")).toBe("BLOCKED");
    expect(st("08:00")).toBe("AVAILABLE");
    expect(st("18:00")).toBe("BOOKED");
    expect(st("19:00")).toBe("BOOKED");
    expect(st("21:00")).toBe("BOOKED"); // live hold
    expect(st("22:00")).toBe("AVAILABLE"); // expired hold
    expect(st("10:00")).toBe("AVAILABLE"); // cancelled
  });
  it("lists bookable dates from today for maxDaysAhead days", () => {
    const d = bookableDates(new Date("2026-11-17T20:00:00Z"), 14); // 01:30 IST on the 18th
    expect(d[0]).toBe("2026-11-18");
    expect(d).toHaveLength(14);
  });
  it("isBookingActive treats holds by expiry", () => {
    const now = new Date();
    expect(isBookingActive({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(isBookingActive({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() - 1000) }, now)).toBe(false);
    expect(isBookingActive({ status: "EXPIRED", holdExpiresAt: null }, now)).toBe(false);
  });
});

describe("pickConsecutive", () => {
  const slots = generateSlots({ ...base, dateKey: "2026-11-20", hours, now: new Date(0) });
  it("accepts back-to-back slots in any order", () => {
    const r = pickConsecutive(slots, ["19:00", "18:00"]);
    expect(r.ok && r.slots.map((s) => s.time)).toEqual(["18:00", "19:00"]);
  });
  it("rejects gaps and unknown slots", () => {
    expect(pickConsecutive(slots, ["18:00", "20:00"])).toMatchObject({ ok: false, error: "NOT_CONSECUTIVE" });
    expect(pickConsecutive(slots, ["05:00"])).toMatchObject({ ok: false, error: "UNKNOWN_SLOT" });
    expect(pickConsecutive(slots, [])).toMatchObject({ ok: false, error: "EMPTY" });
  });
});

describe("refundFor (cancellation policy)", () => {
  const startAt = new Date("2026-11-20T12:30:00Z");
  const policy = { cancelCutoffHours: 0, refundCutoffHours: 24, refundPercentBeforeCutoff: 100, refundPercentAfterCutoff: 0 };
  const at = (hoursBefore: number, extraMs = 0) => new Date(startAt.getTime() - hoursBefore * 3_600_000 + extraMs);
  it("refunds fully at or before the cutoff", () => {
    expect(refundFor(policy, { startAt, paidAmount: 300, now: at(48) })).toBe(300);
    expect(refundFor(policy, { startAt, paidAmount: 300, now: at(24) })).toBe(300);
  });
  it("uses the after-cutoff percent inside the cutoff", () => {
    expect(refundFor(policy, { startAt, paidAmount: 300, now: at(24, 1) })).toBe(0);
    expect(refundFor(policy, { startAt, paidAmount: 300, now: at(1) })).toBe(0);
    expect(refundFor({ ...policy, refundPercentAfterCutoff: 25 }, { startAt, paidAmount: 300, now: at(1) })).toBe(75);
  });
  it("applies the configured before-cutoff percent", () => {
    expect(refundFor({ ...policy, refundPercentBeforeCutoff: 50 }, { startAt, paidAmount: 300, now: at(72) })).toBe(150);
  });
  it("online cancelling closes at the cancel cutoff", () => {
    expect(canCancelOnline(policy, startAt, at(0.5))).toBe(true);
    expect(canCancelOnline(policy, startAt, at(0))).toBe(false);
    expect(canCancelOnline({ ...policy, cancelCutoffHours: 2 }, startAt, at(1))).toBe(false);
  });
});
