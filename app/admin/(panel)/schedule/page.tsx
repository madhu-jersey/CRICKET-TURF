import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { listCourts } from "@/lib/booking/data";
import { addDays, isValidDateKey, istDateKey, istToUtc, dayOfWeek } from "@/lib/time";
import { PageHeader } from "@/components/admin/shell";
import { Schedule } from "@/components/admin/schedule";

export const metadata = { title: "Schedule" };

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { admin } = await requireAdminPage("STAFF");
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : "day";
  const date = sp.date && isValidDateKey(sp.date) ? sp.date : istDateKey(new Date());
  const db = await getDb();
  const courts = (await listCourts(db)).filter((c) => c.isActive);
  const courtId = sp.court && courts.some((c) => c.id === sp.court) ? sp.court : courts[0]?.id;
  // Week view starts on Monday.
  const start = view === "week" ? addDays(date, -((dayOfWeek(date) + 6) % 7)) : date;
  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(start, i)) : [date];
  const from = istToUtc(days[0], 0);
  const to = istToUtc(addDays(days[days.length - 1], 1), 0);
  const courtFilter = view === "week" && courtId ? [courtId] : courts.map((c) => c.id);
  const now = new Date();

  const [bookings, blocks, hours] = await Promise.all([
    db
      .select({ id: schema.bookings.id, code: schema.bookings.bookingCode, courtId: schema.bookings.courtId, startAt: schema.bookings.startAt, endAt: schema.bookings.endAt, status: schema.bookings.status, source: schema.bookings.source, holdExpiresAt: schema.bookings.holdExpiresAt, name: schema.customers.name })
      .from(schema.bookings)
      .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
      .where(and(inArray(schema.bookings.courtId, courtFilter), lt(schema.bookings.startAt, to), gt(schema.bookings.endAt, from), inArray(schema.bookings.status, ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "NO_SHOW"]))),
    db.select().from(schema.blockedSlots).where(and(inArray(schema.blockedSlots.courtId, courtFilter), lt(schema.blockedSlots.startAt, to), gt(schema.blockedSlots.endAt, from))),
    db.select().from(schema.operatingHours).where(inArray(schema.operatingHours.courtId, courtFilter)),
  ]);

  return (
    <>
      <PageHeader title="Schedule" />
      <Schedule
        view={view}
        date={date}
        days={days}
        courts={courts.map((c) => ({ id: c.id, name: c.name, slotMinutes: c.slotMinutes }))}
        courtId={courtId ?? ""}
        role={admin.role}
        hours={hours.map((h) => ({ courtId: h.courtId, dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, isClosed: h.isClosed }))}
        bookings={bookings
          .filter((b) => b.status !== "PENDING_PAYMENT" || (b.holdExpiresAt && b.holdExpiresAt > now))
          .map((b) => ({ id: b.id, code: b.code, courtId: b.courtId, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), status: b.status, source: b.source, name: b.name }))}
        blocks={blocks.map((b) => ({ id: b.id, courtId: b.courtId, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), reason: b.reason, note: b.note }))}
        today={istDateKey(now)}
      />
    </>
  );
}
