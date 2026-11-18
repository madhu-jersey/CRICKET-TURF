import { requireAdminPage } from "@/lib/auth/admin";
import { listCourts } from "@/lib/booking/data";
import { PageHeader } from "@/components/admin/shell";
import { WalkInForm } from "@/components/admin/walk-in-form";
import { isValidDateKey, istDateKey } from "@/lib/time";

export const metadata = { title: "Walk-in booking" };

export default async function WalkInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminPage("STAFF");
  const sp = await searchParams;
  const courts = (await listCourts(undefined, { activeOnly: true })).map((c) => ({ id: c.id, name: c.name }));
  return (
    <>
      <PageHeader title="Walk-in / phone booking" />
      <WalkInForm
        courts={courts}
        initial={{
          courtId: sp.court && courts.some((c) => c.id === sp.court) ? sp.court : courts[0]?.id,
          date: sp.date && isValidDateKey(sp.date) ? sp.date : istDateKey(new Date()),
          times: sp.times ? sp.times.split(",").filter((t) => /^\d{2}:\d{2}$/.test(t)) : [],
        }}
      />
    </>
  );
}
