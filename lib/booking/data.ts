/** Read-side helpers shared by pages, API routes and the booking service. */
import "server-only";
import { and, asc, eq, gt, gte, inArray, lt, desc } from "drizzle-orm";
import { getDb, schema, type Queryable } from "@/db/client";
import { siteConfig } from "@/config/site";
import { getDayType } from "@/lib/pricing";
import { addDays, dayOfWeek, istDateKey, istToUtc } from "@/lib/time";
import { generateSlots, isDateBookable, type Slot } from "@/lib/booking/slots";
import { AppError } from "@/lib/errors";
import type { DayType, SettingsRow, SportName } from "@/db/schema";

export async function getSettings(q?: Queryable): Promise<SettingsRow> {
  const db = q ?? (await getDb());
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  if (row) return row;
  return {
    id: 1,
    advanceType: "FIXED",
    advanceValue: 300,
    holdMinutes: 10,
    refundCutoffHours: 2,
    refundPercentBeforeCutoff: 100,
    maxDaysAhead: 14,
    newCustomerDiscountPercent: 10,
    maxActiveBookingsPerPhone: 2,
    maxBookingsPerPhonePerDay: 4,
    noShowBlockThreshold: 3,
    autoCompleteHours: 6,
    otpDailyCapNew: 200,
    otpDailyCapReturning: 300,
    otpCapBoost: 0,
    otpCapBoostDate: null,
    otpSendPerIpHour: 30,
    otpVerifyPerIpHour: 60,
    bookingPerIpHour: 60,
    cancelPerIpHour: 30,
    cancelCutoffHours: 0,
    refundPercentAfterCutoff: 0,
    ownerAlertPhone: null,
    businessName: siteConfig.name,
    address: siteConfig.streetAddress,
    mapLink: siteConfig.mapLink,
    phone: siteConfig.phoneE164,
    updatedAt: new Date(),
  };
}

export type CourtWithSport = {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  sportId: string;
  sport: SportName;
  slotMinutes: number;
};

export async function listCourts(q?: Queryable, opts: { activeOnly?: boolean } = {}): Promise<CourtWithSport[]> {
  const db = q ?? (await getDb());
  const rows = await db
    .select({
      id: schema.courts.id,
      name: schema.courts.name,
      isActive: schema.courts.isActive,
      sortOrder: schema.courts.sortOrder,
      sportId: schema.courts.sportId,
      sport: schema.sports.name,
      slotMinutes: schema.sports.slotDurationMinutes,
    })
    .from(schema.courts)
    .innerJoin(schema.sports, eq(schema.courts.sportId, schema.sports.id))
    .where(opts.activeOnly ? eq(schema.courts.isActive, true) : undefined)
    .orderBy(asc(schema.sports.sortOrder), asc(schema.courts.sortOrder));
  return rows;
}

export async function getCourt(q: Queryable, courtId: string): Promise<CourtWithSport | null> {
  const all = await listCourts(q);
  return all.find((c) => c.id === courtId) ?? null;
}

export async function getHolidayKeys(q: Queryable, from: string, to: string): Promise<Set<string>> {
  const rows = await q
    .select({ date: schema.holidays.date })
    .from(schema.holidays)
    .where(and(gte(schema.holidays.date, from), lt(schema.holidays.date, addDays(to, 1))));
  return new Set(rows.map((r) => r.date));
}

export type Availability = {
  court: CourtWithSport;
  dateKey: string;
  dayType: DayType;
  slots: Slot[];
};

/**
 * Builds the slot grid for one court and date from live DB state. Used by the public API, the
 * booking service (to validate a selection right before inserting) and the admin walk-in form.
 */
export async function loadAvailability(
  q: Queryable,
  courtId: string,
  dateKey: string,
  now: Date,
  opts: { admin?: boolean } = {},
): Promise<Availability> {
  const court = await getCourt(q, courtId);
  if (!court || !court.isActive) throw new AppError("NOT_FOUND", "This court is not available for booking.");
  const settings = await getSettings(q);
  const dayStart = istToUtc(dateKey, 0);
  const dayEnd = istToUtc(addDays(dateKey, 1), 0);
  const empty = { court, dateKey, dayType: "WEEKDAY" as DayType, slots: [] as Slot[] };
  // Customers: today … maxDaysAhead. Admin walk-ins: any date from today on, including started slots.
  if (!opts.admin && !isDateBookable(dateKey, now, settings.maxDaysAhead)) return empty;
  if (opts.admin && dateKey < istDateKey(now)) return empty;

  const [hoursRows, rules, blocks, bookings, holidaysSet] = await Promise.all([
    q.select().from(schema.operatingHours).where(and(eq(schema.operatingHours.courtId, courtId), eq(schema.operatingHours.dayOfWeek, dayOfWeek(dateKey)))),
    q.select().from(schema.pricingRules).where(eq(schema.pricingRules.courtId, courtId)),
    q
      .select({ startAt: schema.blockedSlots.startAt, endAt: schema.blockedSlots.endAt })
      .from(schema.blockedSlots)
      .where(and(eq(schema.blockedSlots.courtId, courtId), lt(schema.blockedSlots.startAt, dayEnd), gt(schema.blockedSlots.endAt, dayStart))),
    q
      .select({ startAt: schema.bookings.startAt, endAt: schema.bookings.endAt, status: schema.bookings.status, holdExpiresAt: schema.bookings.holdExpiresAt })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.courtId, courtId),
          lt(schema.bookings.startAt, dayEnd),
          gt(schema.bookings.endAt, dayStart),
          inArray(schema.bookings.status, ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "NO_SHOW"]),
        ),
      ),
    getHolidayKeys(q, dateKey, dateKey),
  ]);
  const dayType = getDayType(dateKey, holidaysSet);
  const slots = generateSlots({
    dateKey,
    hours: hoursRows[0] ?? null,
    slotMinutes: court.slotMinutes,
    rules,
    dayType,
    now,
    blocks,
    bookings,
    allowStarted: opts.admin,
  });
  return { court, dateKey, dayType, slots };
}

/** Next N free slots today (or the next day with free slots) for a sport, across its courts. */
export async function nextFreeSlots(sport: SportName, n: number, now = new Date()) {
  const db = await getDb();
  const courts = (await listCourts(db, { activeOnly: true })).filter((c) => c.sport === sport);
  const today = istDateKey(now);
  for (let d = 0; d < 2; d++) {
    const dateKey = addDays(today, d);
    const all: { court: CourtWithSport; slot: Slot }[] = [];
    for (const court of courts) {
      const a = await loadAvailability(db, court.id, dateKey, now);
      for (const slot of a.slots) if (slot.state === "AVAILABLE") all.push({ court, slot });
    }
    if (all.length) {
      all.sort((x, y) => x.slot.startAt.localeCompare(y.slot.startAt) || x.court.sortOrder - y.court.sortOrder);
      // One entry per start time (any court), so the strip shows distinct times.
      const seen = new Set<string>();
      const out = all.filter((x) => (seen.has(x.slot.time) ? false : (seen.add(x.slot.time), true))).slice(0, n);
      return { dateKey, items: out };
    }
  }
  return { dateKey: today, items: [] };
}

export async function startingPrices() {
  const db = await getDb();
  const courts = await listCourts(db, { activeOnly: true });
  const rules = await db.select().from(schema.pricingRules);
  const out: Partial<Record<SportName, number>> = {};
  for (const c of courts) {
    for (const r of rules.filter((r) => r.courtId === c.id)) {
      out[c.sport] = Math.min(out[c.sport] ?? Infinity, r.pricePerSlot);
    }
  }
  return out;
}

export type BookingDetails = NonNullable<Awaited<ReturnType<typeof getBookingByCode>>>;

export async function getBookingByCode(code: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const [row] = await db
    .select({ booking: schema.bookings, customer: schema.customers, courtName: schema.courts.name, sport: schema.sports.name })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
    .innerJoin(schema.sports, eq(schema.courts.sportId, schema.sports.id))
    .where(eq(schema.bookings.bookingCode, code));
  if (!row) return null;
  const payments = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, row.booking.id)).orderBy(desc(schema.payments.createdAt));
  return { ...row, payments };
}

export async function getBookingById(id: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const [b] = await db.select({ code: schema.bookings.bookingCode }).from(schema.bookings).where(eq(schema.bookings.id, id));
  return b ? getBookingByCode(b.code, db) : null;
}

/** Sum of money actually collected and not refunded for a booking. */
export function netPaid(payments: { status: string; amount: number; refundAmount: number }[]): number {
  return payments.filter((p) => p.status === "PAID" || p.status === "REFUNDED").reduce((s, p) => s + p.amount - p.refundAmount, 0);
}
