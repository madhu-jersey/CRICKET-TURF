import { asc, gt } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { listCourts } from "@/lib/booking/data";
import { Card, PageHeader } from "@/components/admin/shell";
import { BlockForm } from "@/components/admin/block-form";
import { DeleteButton } from "@/components/admin/delete-button";
import { formatDate, formatTimeRange, istDateKey } from "@/lib/time";

export const metadata = { title: "Blocked slots" };

export default async function BlockedPage() {
  await requireAdminPage("OWNER");
  const db = await getDb();
  const [courts, blocks] = await Promise.all([listCourts(db), db.select().from(schema.blockedSlots).where(gt(schema.blockedSlots.endAt, new Date())).orderBy(asc(schema.blockedSlots.startAt))]);
  const name = (id: string) => courts.find((c) => c.id === id)?.name ?? "?";

  return (
    <>
      <PageHeader title="Blocked slots" />
      <Card title="Block time" className="mb-6">
        <BlockForm courts={courts.map((c) => ({ id: c.id, name: c.name }))} initial={{ startDate: istDateKey(new Date()) }} />
      </Card>
      <Card title="Upcoming blocks">
        {blocks.length === 0 && <p className="text-sm text-zinc-500">No upcoming blocks.</p>}
        <ul className="divide-y divide-zinc-100">
          {blocks.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-semibold">{name(b.courtId)} · {formatDate(b.startAt)}, {formatTimeRange(b.startAt, b.endAt)}</p>
                <p className="text-zinc-500">{b.reason.replace("_", " ").toLowerCase()}{b.note ? ` — ${b.note}` : ""}{b.recurrenceGroupId ? " · repeating" : ""}</p>
              </div>
              <div className="flex gap-2">
                <DeleteButton url={`/api/admin/blocks?id=${b.id}`} label="Remove" />
                {b.recurrenceGroupId && <DeleteButton url={`/api/admin/blocks?group=${encodeURIComponent(b.recurrenceGroupId)}`} label="Remove series" confirmText="Remove every block in this series?" />}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
