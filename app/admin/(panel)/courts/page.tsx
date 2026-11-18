import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { listCourts } from "@/lib/booking/data";
import { PageHeader } from "@/components/admin/shell";
import { CourtEditor } from "@/components/admin/court-editor";

export const metadata = { title: "Courts & hours" };

export default async function CourtsPage() {
  await requireAdminPage("OWNER");
  const db = await getDb();
  const [courts, hours] = await Promise.all([listCourts(db), db.select().from(schema.operatingHours)]);
  return (
    <>
      <PageHeader title="Courts & hours" />
      <div className="grid gap-4 xl:grid-cols-2">
        {courts.map((c) => (
          <CourtEditor
            key={c.id}
            court={{ id: c.id, name: c.name, isActive: c.isActive, sport: c.sport }}
            hours={Array.from({ length: 7 }, (_, d) => {
              const h = hours.find((x) => x.courtId === c.id && x.dayOfWeek === d);
              return { dayOfWeek: d, openTime: h?.openTime ?? "06:00", closeTime: h?.closeTime ?? "23:00", isClosed: h?.isClosed ?? false };
            })}
          />
        ))}
      </div>
    </>
  );
}
