/** Read models for the admin dashboard. */
import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, count, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { addDays, istDateKey, istToUtc, istMinutesOfDay, dayOfWeek, timeToMinutes } from "@/lib/time";
import { listCourts } from "@/lib/booking/data";
import type { BookingStatus, BookingSource } from "@/db/schema";

const ACTIVE: BookingStatus[] = ["CONFIRMED", "COMPLETED", "NO_SHOW"];

export async function overview(now = new Date()) {
  const db = await getDb();
  const today = istDateKey(now);
  const dayStart = istToUtc(today, 0);
  const dayEnd = istToUtc(addDays(today, 1), 0);
  const weekStart = istToUtc(addDays(today, -6), 0);
  const courts = await listCourts(db);

  const [todays, payments, upcoming, hours, history] = await Promise.all([
    db
      .select({ courtId: schema.bookings.courtId, startAt: schema.bookings.startAt, endAt: schema.bookings.endAt })
      .from(schema.bookings)
      .where(and(gte(schema.bookings.startAt, dayStart), lt(schema.bookings.startAt, dayEnd), inArray(schema.bookings.status, [...ACTIVE, "PENDING_PAYMENT"]))),
    db
      .select({ amount: schema.payments.amount, refund: schema.payments.refundAmount, paidAt: schema.payments.paidAt, kind: schema.payments.kind })
      .from(schema.payments)
      .where(and(inArray(schema.payments.status, ["PAID", "REFUNDED"]), gte(schema.payments.paidAt, weekStart), lt(schema.payments.paidAt, dayEnd))),
    db
      .select({ id: schema.bookings.id, code: schema.bookings.bookingCode, startAt: schema.bookings.startAt, endAt: schema.bookings.endAt, name: schema.customers.name, court: schema.courts.name, balance: schema.bookings.balanceAmount, balancePaidAt: schema.bookings.balancePaidAt })
      .from(schema.bookings)
      .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
      .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
      .where(and(eq(schema.bookings.status, "CONFIRMED"), gte(schema.bookings.endAt, now)))
      .orderBy(asc(schema.bookings.startAt))
      .limit(3),
    db.select().from(schema.operatingHours),
    db
      .select({ startAt: schema.bookings.startAt, endAt: schema.bookings.endAt })
      .from(schema.bookings)
      .where(and(gte(schema.bookings.startAt, istToUtc(addDays(today, -28), 0)), lt(schema.bookings.startAt, dayEnd), inArray(schema.bookings.status, ACTIVE))),
  ]);

  // Revenue per IST day (advance + balance collected, net of refunds).
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const revenueByDay = days.map((d) => ({ date: d, advance: 0, balance: 0 }));
  let todayAdvance = 0;
  let todayBalance = 0;
  for (const p of payments) {
    if (!p.paidAt) continue;
    const key = istDateKey(p.paidAt);
    const row = revenueByDay.find((r) => r.date === key);
    const net = p.amount - p.refund;
    if (row) row[p.kind === "BALANCE" ? "balance" : "advance"] += net;
    if (key === today) {
      if (p.kind === "BALANCE") todayBalance += net;
      else todayAdvance += net;
    }
  }

  // Occupancy today per court = booked minutes / open minutes.
  const dow = dayOfWeek(today);
  const occupancy = courts
    .filter((c) => c.isActive)
    .map((c) => {
      const h = hours.find((x) => x.courtId === c.id && x.dayOfWeek === dow);
      const open = h && !h.isClosed ? timeToMinutes(h.closeTime) - timeToMinutes(h.openTime) : 0;
      const booked = todays.filter((b) => b.courtId === c.id).reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()) / 60_000, 0);
      return { court: c.name, pct: open ? Math.round((booked / open) * 100) : 0 };
    });

  // Busiest hours heatmap over the last 4 weeks: [dayOfWeek][hour] = bookings.
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const b of history) {
    for (let t = b.startAt.getTime(); t < b.endAt.getTime(); t += 3_600_000) {
      const d = new Date(t);
      heat[dayOfWeek(istDateKey(d))][Math.floor(istMinutesOfDay(d) / 60)]++;
    }
  }

  return { todayCount: todays.length, todayAdvance, todayBalance, revenueByDay, occupancy, upcoming, heat };
}

export type BookingFilters = {
  q?: string;
  from?: string;
  to?: string;
  sport?: string;
  court?: string;
  status?: string;
  source?: string;
  page?: number;
};

export async function searchBookings(f: BookingFilters, opts: { pageSize?: number; all?: boolean } = {}) {
  const db = await getDb();
  const where: SQL[] = [];
  if (f.q) {
    const q = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    where.push(or(ilike(schema.customers.name, q), ilike(schema.customers.phone, q), ilike(schema.bookings.bookingCode, q))!);
  }
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) where.push(gte(schema.bookings.startAt, istToUtc(f.from, 0)));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) where.push(lt(schema.bookings.startAt, istToUtc(addDays(f.to, 1), 0)));
  if (f.sport === "CRICKET" || f.sport === "PICKLEBALL") where.push(eq(schema.sports.name, f.sport));
  if (f.court) where.push(eq(schema.bookings.courtId, f.court));
  if (f.status) where.push(eq(schema.bookings.status, f.status as BookingStatus));
  if (f.source) where.push(eq(schema.bookings.source, f.source as BookingSource));
  const cond = where.length ? and(...where) : undefined;
  const pageSize = opts.pageSize ?? 20;
  const page = Math.max(1, f.page ?? 1);

  const base = db
    .select({
      id: schema.bookings.id,
      code: schema.bookings.bookingCode,
      startAt: schema.bookings.startAt,
      endAt: schema.bookings.endAt,
      status: schema.bookings.status,
      source: schema.bookings.source,
      total: schema.bookings.totalAmount,
      advance: schema.bookings.advanceAmount,
      balance: schema.bookings.balanceAmount,
      balancePaidAt: schema.bookings.balancePaidAt,
      refund: schema.bookings.refundAmount,
      createdAt: schema.bookings.createdAt,
      name: schema.customers.name,
      phone: schema.customers.phone,
      court: schema.courts.name,
      sport: schema.sports.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
    .innerJoin(schema.sports, eq(schema.courts.sportId, schema.sports.id))
    .where(cond)
    .orderBy(desc(schema.bookings.startAt));

  const rows = opts.all ? await base.limit(5000) : await base.limit(pageSize).offset((page - 1) * pageSize);
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
    .innerJoin(schema.sports, eq(schema.courts.sportId, schema.sports.id))
    .where(cond);
  return { rows, total: n, page, pageSize };
}

export async function customerList(q?: string) {
  const db = await getDb();
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  return db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      phone: schema.customers.phone,
      optIn: schema.customers.whatsappOptIn,
      createdAt: schema.customers.createdAt,
      bookings: sql<number>`count(${schema.bookings.id}) filter (where ${schema.bookings.status} in ('CONFIRMED','COMPLETED','NO_SHOW'))`.mapWith(Number),
      lastVisit: sql<Date | null>`max(${schema.bookings.startAt}) filter (where ${schema.bookings.status} = 'COMPLETED')`.mapWith((v) => (v ? new Date(v) : null)),
      spent: sql<number>`coalesce((select sum(p."amount" - p."refundAmount") from "Payment" p join "Booking" b2 on b2."id" = p."bookingId" where b2."customerId" = ${schema.customers.id} and p."status" in ('PAID','REFUNDED')), 0)`.mapWith(Number),
    })
    .from(schema.customers)
    .leftJoin(schema.bookings, eq(schema.bookings.customerId, schema.customers.id))
    .where(like ? or(ilike(schema.customers.name, like), ilike(schema.customers.phone, like)) : undefined)
    .groupBy(schema.customers.id)
    .orderBy(desc(sql`count(${schema.bookings.id})`))
    .limit(500);
}
