import Link from "next/link";
import { desc, count } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { PageHeader } from "@/components/admin/shell";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Audit log" };
const PAGE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAdminPage("OWNER");
  const page = Math.max(1, Number((await searchParams).page ?? 1) || 1);
  const db = await getDb();
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(PAGE).offset((page - 1) * PAGE),
    db.select({ n: count() }).from(schema.auditLogs),
  ]);
  return (
    <>
      <PageHeader title="Audit log" />
      <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-3">When</th>
              <th scope="col" className="px-4 py-3">Who</th>
              <th scope="col" className="px-4 py-3">Action</th>
              <th scope="col" className="px-4 py-3">Entity</th>
              <th scope="col" className="px-4 py-3">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 align-top">
            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">Nothing logged yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-3 text-xs">{formatDateTime(r.createdAt)}</td>
                <td className="px-4 py-3 text-xs">{r.actor}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.action}</td>
                <td className="px-4 py-3 text-xs">{r.entity}<span className="block font-mono text-[10px] text-zinc-500">{r.entityId?.slice(0, 12)}</span></td>
                <td className="px-4 py-3">
                  <details>
                    <summary className="cursor-pointer text-xs font-semibold">View</summary>
                    <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap text-[11px] text-zinc-700">{JSON.stringify({ before: r.before, after: r.after }, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="mt-4 flex justify-between text-sm" aria-label="Pagination">
        <span className="text-zinc-500">{n} entries</span>
        <span className="flex gap-2">
          {page > 1 && <Link className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 bg-white px-4 md:min-h-0 md:py-1" href={`?page=${page - 1}`}>← Newer</Link>}
          {page * PAGE < n && <Link className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 bg-white px-4 md:min-h-0 md:py-1" href={`?page=${page + 1}`}>Older →</Link>}
        </span>
      </nav>
    </>
  );
}
