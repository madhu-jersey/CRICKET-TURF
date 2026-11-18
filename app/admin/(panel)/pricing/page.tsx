import { asc } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { listCourts } from "@/lib/booking/data";
import { Card, PageHeader } from "@/components/admin/shell";
import { PricingEditor } from "@/components/admin/pricing-editor";
import { HolidayForm } from "@/components/admin/holiday-form";
import { DeleteButton } from "@/components/admin/delete-button";
import { formatDate, istDateKey, istToUtc } from "@/lib/time";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  await requireAdminPage("OWNER");
  const db = await getDb();
  const [courts, rules, holidays] = await Promise.all([
    listCourts(db),
    db.select().from(schema.pricingRules).orderBy(asc(schema.pricingRules.startTime)),
    db.select().from(schema.holidays).orderBy(asc(schema.holidays.date)),
  ]);
  const today = istDateKey(new Date());
  return (
    <>
      <PageHeader title="Pricing" />
      <PricingEditor
        courts={courts.map((c) => ({ id: c.id, name: c.name, sport: c.sport }))}
        rules={rules.map((r) => ({ courtId: r.courtId, dayType: r.dayType, startTime: r.startTime, endTime: r.endTime, pricePerSlot: r.pricePerSlot }))}
      />
      <Card title="Holidays (charged at holiday rates)" className="mt-6">
        <HolidayForm />
        <ul className="mt-4 divide-y divide-zinc-100">
          {holidays.length === 0 && <li className="py-2 text-sm text-zinc-500">No holidays yet.</li>}
          {holidays.map((h) => (
            <li key={h.id} className={`flex items-center justify-between py-2 text-sm ${h.date < today ? "opacity-50" : ""}`}>
              <span><strong>{formatDate(istToUtc(h.date, 720))}</strong> — {h.name}</span>
              <DeleteButton url={`/api/admin/holidays?id=${h.id}`} label="Remove" />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
