import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { customerList } from "@/lib/admin/reports";
import { PageHeader } from "@/components/admin/shell";
import { formatDateShort } from "@/lib/time";
import { inr } from "@/lib/utils";

export const metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdminPage("OWNER");
  const { q } = await searchParams;
  const rows = await customerList(q);
  return (
    <>
      <PageHeader title="Customers" />
      <form className="mb-4 flex gap-2" method="get">
        <input name="q" defaultValue={q} placeholder="Search name or phone" aria-label="Search customers" className="h-10 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm" />
        <button className="h-10 rounded-lg bg-ink px-4 text-sm font-bold text-white">Search</button>
      </form>
      <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-3">Name</th>
              <th scope="col" className="px-4 py-3">Phone</th>
              <th scope="col" className="px-4 py-3 text-right">Bookings</th>
              <th scope="col" className="px-4 py-3 text-right">Total spent</th>
              <th scope="col" className="px-4 py-3">Last visit</th>
              <th scope="col" className="px-4 py-3">WhatsApp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-500">No customers found.</td></tr>}
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-zinc-50">
                <td className="px-4 py-3"><Link className="font-semibold underline-offset-2 hover:underline" href={`/admin/customers/${c.id}`}>{c.name}</Link></td>
                <td className="px-4 py-3">{c.phone}</td>
                <td className="px-4 py-3 text-right tabular-nums">{c.bookings}</td>
                <td className="px-4 py-3 text-right tabular-nums">{inr(c.spent)}</td>
                <td className="px-4 py-3">{c.lastVisit ? formatDateShort(c.lastVisit) : "—"}</td>
                <td className="px-4 py-3">{c.optIn ? <span className="font-semibold text-emerald-700">Opted in</span> : <span className="text-zinc-500">No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
