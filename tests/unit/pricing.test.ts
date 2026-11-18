import { describe, expect, it } from "vitest";
import { computeAdvance, discountFor, getDayType, priceBreakdown, priceForSlot, type PricingRuleLite } from "@/lib/pricing";

const cricket: PricingRuleLite[] = [
  { dayType: "WEEKDAY", startTime: "06:00", endTime: "18:00", pricePerSlot: 800 },
  { dayType: "WEEKDAY", startTime: "18:00", endTime: "24:00", pricePerSlot: 1200 },
  { dayType: "WEEKEND", startTime: "06:00", endTime: "18:00", pricePerSlot: 1000 },
  { dayType: "WEEKEND", startTime: "18:00", endTime: "24:00", pricePerSlot: 1400 },
  { dayType: "HOLIDAY", startTime: "18:00", endTime: "24:00", pricePerSlot: 1600 },
];

describe("getDayType", () => {
  it("detects weekdays, weekends and holidays", () => {
    expect(getDayType("2026-11-18", new Set())).toBe("WEEKDAY"); // Wednesday
    expect(getDayType("2026-11-21", new Set())).toBe("WEEKEND"); // Saturday
    expect(getDayType("2026-11-22", new Set())).toBe("WEEKEND"); // Sunday
    expect(getDayType("2026-11-18", new Set(["2026-11-18"]))).toBe("HOLIDAY");
  });
});

describe("priceForSlot", () => {
  it("uses the day rate right up to the night boundary", () => {
    expect(priceForSlot(cricket, "WEEKDAY", 17 * 60)).toBe(800); // 5 PM slot
    expect(priceForSlot(cricket, "WEEKDAY", 18 * 60)).toBe(1200); // 6 PM is night
    expect(priceForSlot(cricket, "WEEKDAY", 17 * 60 + 59)).toBe(800);
  });
  it("applies weekend prices", () => {
    expect(priceForSlot(cricket, "WEEKEND", 10 * 60)).toBe(1000);
    expect(priceForSlot(cricket, "WEEKEND", 20 * 60)).toBe(1400);
  });
  it("uses holiday rules and falls back to weekend where no holiday rule exists", () => {
    expect(priceForSlot(cricket, "HOLIDAY", 19 * 60)).toBe(1600);
    expect(priceForSlot(cricket, "HOLIDAY", 9 * 60)).toBe(1000);
  });
  it("returns null when nothing covers the slot", () => {
    expect(priceForSlot(cricket, "WEEKDAY", 5 * 60)).toBeNull();
  });
});

describe("advance + multi-slot totals", () => {
  it("sums multiple slots across the day/night boundary", () => {
    const prices = [17 * 60, 18 * 60].map((m) => priceForSlot(cricket, "WEEKDAY", m)!);
    expect(priceBreakdown(prices, { advanceType: "FIXED", advanceValue: 300 })).toEqual({ subtotal: 2000, discount: 0, total: 2000, advance: 300, balance: 1700 });
  });
  it("computes percent advance with rounding", () => {
    expect(computeAdvance(1200, { advanceType: "PERCENT", advanceValue: 30 })).toBe(360);
    expect(computeAdvance(1015, { advanceType: "PERCENT", advanceValue: 33 })).toBe(335);
  });
  it("never asks for more than the total", () => {
    expect(computeAdvance(200, { advanceType: "FIXED", advanceValue: 300 })).toBe(200);
    expect(computeAdvance(0, { advanceType: "FIXED", advanceValue: 300 })).toBe(0);
  });
});

describe("new customer discount", () => {
  it("takes the percent off before the advance is calculated", () => {
    expect(priceBreakdown([1200, 1200], { advanceType: "PERCENT", advanceValue: 30 }, 10)).toEqual({ subtotal: 2400, discount: 240, total: 2160, advance: 648, balance: 1512 });
    expect(priceBreakdown([800], { advanceType: "FIXED", advanceValue: 300 }, 10)).toEqual({ subtotal: 800, discount: 80, total: 720, advance: 300, balance: 420 });
  });
  it("rounds the discount down and handles 0%", () => {
    expect(discountFor(1015, 10)).toBe(101);
    expect(discountFor(1000, 0)).toBe(0);
    expect(discountFor(0, 10)).toBe(0);
  });
});
