import { notFound } from "next/navigation";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { Card, PageHeader } from "@/components/admin/shell";
import { BookingsTable } from "@/components/admin/bookings-table";
import { formatDate } from "@/lib/time";
import { inr } from "@/lib/utils";

export const metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { admin } = await requireAdminPage("OWNER");
  const { id } = await params;
  const db = await getDb();
  const [c] = await db.select().from(schema.customers).where(eq(schema.customers.id, id));
  if (!c) notFound();
  const rows = await db
    .select({ id: schema.bookings.id, code: schema.bookings.bookingCode, startAt: schema.bookings.startAt, endAt: schema.bookings.endAt, status: schema.bookings.status, source: schema.bookings.source, total: schema.bookings.totalAmount, balance: schema.bookings.balanceAmount, balancePaidAt: schema.bookings.balancePaidAt, court: schema.courts.name })
    .from(schema.bookings)
    .innerJoin(schema.courts, eq(schema.bookings.courtId, schema.courts.id))
    .where(eq(schema.bookings.customerId, id))
    .orderBy(desc(schema.bookings.startAt));
  const pays = await db.select({ amount: schema.payments.amount, refund: schema.payments.refundAmount, status: schema.payments.status }).from(schema.payments).innerJoin(schema.bookings, eq(schema.payments.bookingId, schema.bookings.id)).where(eq(schema.bookings.customerId, id));
  const spent = pays.filter((p) => p.status === "PAID" || p.status === "REFUNDED").reduce((s, p) => s + p.amount - p.refund, 0);

  return (
    <>
      <Link href="/admin/customers" className="text-sm font-semibold underline">← Customers</Link>
      <PageHeader title={c.name} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><p className="text-sm text-zinc-500">Phone</p><a href={`tel:${c.phone}`} className="font-semibold underline">{c.phone}</a></Card>
        <Card><p className="text-sm text-zinc-500">Bookings</p><p className="font-display text-3xl font-bold">{rows.length}</p></Card>
        <Card><p className="text-sm text-zinc-500">Total spent</p><p className="font-display text-3xl font-bold">{inr(spent)}</p></Card>
        <Card><p className="text-sm text-zinc-500">WhatsApp</p><p className="font-semibold">{c.whatsappOptIn ? `Opted in${c.optInAt ? ` on ${formatDate(c.optInAt)}` : ""}` : "Not opted in"}</p><p className="text-xs text-zinc-500">Customer since {formatDate(c.createdAt)}</p></Card>
      </div>
      <BookingsTable
        role={admin.role}
        rows={rows.map((r) => ({ ...r, name: c.name, phone: c.phone, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), balancePaidAt: r.balancePaidAt?.toISOString() ?? null }))}
      />
    </>
  );
}
