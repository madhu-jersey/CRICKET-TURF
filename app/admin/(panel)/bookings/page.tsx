import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { searchBookings } from "@/lib/admin/reports";
import { listCourts } from "@/lib/booking/data";
import { PageHeader } from "@/components/admin/shell";
import { BookingsTable } from "@/components/admin/bookings-table";
import { Alert } from "@/components/ui/field";

export const metadata = { title: "Bookings" };

const STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "REFUNDED", "NO_SHOW", "EXPIRED"];

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { admin } = await requireAdminPage("STAFF");
  const sp = await searchParams;
  const f = { q: sp.q, from: sp.from, to: sp.to, sport: sp.sport, court: sp.court, status: sp.status, source: sp.source, page: Number(sp.page ?? 1) || 1 };
  const [{ rows, total, page, pageSize }, courts] = await Promise.all([searchBookings(f), listCourts()]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v !== undefined && v !== "" && !(k === "page" && v === 1)) p.set(k, String(v));
    return p.toString();
  };
  const exportQs = qs({ page: undefined });

  return (
    <>
      <PageHeader title="Bookings">
        <a href={`/api/admin/bookings/export${exportQs ? `?${exportQs}` : ""}`} className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-bold">Export CSV</a>
        <Link href="/admin/walk-in" className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-flood">+ Walk-in</Link>
      </PageHeader>
      {sp.denied && <Alert tone="warn" className="mb-4">That page is for the owner only.</Alert>}

      <form className="mb-4 rounded-2xl border border-zinc-200 bg-white p-3" method="get">
        <div className="flex gap-2">
          <input name="q" defaultValue={f.q} placeholder="Search name, phone or code" aria-label="Search" className="h-12 min-w-0 flex-1 rounded-xl border border-zinc-300 px-3 text-base md:h-10 md:text-sm" />
          <button className="h-12 shrink-0 rounded-xl bg-ink px-4 text-sm font-bold text-white md:h-10">Search</button>
        </div>
        <details className="group mt-2" open={!!(f.from || f.to || f.sport || f.court || f.status || f.source)}>
          <summary className="cursor-pointer list-none py-1 text-sm font-semibold text-zinc-600 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">+ More filters</span>
            <span className="hidden group-open:inline">− Fewer filters</span>
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <input type="date" name="from" defaultValue={f.from} aria-label="From date" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm" />
        <input type="date" name="to" defaultValue={f.to} aria-label="To date" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm" />
        <select name="sport" defaultValue={f.sport ?? ""} aria-label="Sport" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm">
          <option value="">All sports</option>
          <option value="CRICKET">Cricket</option>
          <option value="PICKLEBALL">Pickleball</option>
        </select>
        <select name="court" defaultValue={f.court ?? ""} aria-label="Court" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm">
          <option value="">All courts</option>
          {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select name="status" defaultValue={f.status ?? ""} aria-label="Status" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
        </select>
          <select name="source" defaultValue={f.source ?? ""} aria-label="Source" className="h-11 min-w-0 rounded-lg border border-zinc-300 px-2 text-sm">
            <option value="">All sources</option>
            <option value="ONLINE">Online</option>
            <option value="WALK_IN">Walk-in</option>
            <option value="PHONE">Phone</option>
          </select>
          <button className="col-span-2 h-11 rounded-lg bg-ink px-3 text-sm font-bold text-white sm:col-span-1">Apply filters</button>
          </div>
        </details>
      </form>

      <BookingsTable rows={rows.map((r) => ({ ...r, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), balancePaidAt: r.balancePaidAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }))} role={admin.role} />

      <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
        <span className="text-zinc-500">{total} booking{total === 1 ? "" : "s"} · page {page} of {pages}</span>
        <div className="flex gap-2">
          {page > 1 && <Link className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-semibold" href={`?${qs({ page: page - 1 })}`}>← Prev</Link>}
          {page < pages && <Link className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-semibold" href={`?${qs({ page: page + 1 })}`}>Next →</Link>}
        </div>
      </nav>
    </>
  );
}
