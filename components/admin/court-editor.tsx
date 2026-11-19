"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input } from "@/components/ui/field";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type H = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

export function CourtEditor({ court, hours: initial }: { court: { id: string; name: string; isActive: boolean; sport: string }; hours: H[] }) {
  const router = useRouter();
  const [active, setActive] = useState(court.isActive);
  const [hours, setHours] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const save = async (patch: { isActive?: boolean; hours?: H[] }) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await adminApi("/api/admin/courts", { method: "PATCH", json: { id: court.id, ...patch } });
      setOk("Saved.");
      router.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const set = (d: number, patch: Partial<H>) => setHours(hours.map((h) => (h.dayOfWeek === d ? { ...h, ...patch } : h)));
  const order = [1, 2, 3, 4, 5, 6, 0];

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase">{court.name}</h2>
          <p className="text-xs text-zinc-500">{court.sport.toLowerCase()}</p>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={active}
            disabled={busy}
            onChange={async (e) => {
              const v = e.target.checked;
              setActive(v);
              if (!(await save({ isActive: v }))) setActive(!v);
            }}
          />
          {active ? "Open for booking" : "Disabled"}
        </label>
      </div>
      <table className="mt-4 w-full text-sm">
        <tbody>
          {order.map((d) => {
            const h = hours.find((x) => x.dayOfWeek === d)!;
            return (
              <tr key={d} className="border-t border-zinc-100">
                <th scope="row" className="py-1.5 pr-2 text-left font-semibold">{DAYS[d]}</th>
                <td className="py-1.5 pr-2"><label className="flex min-h-11 items-center gap-2 text-xs md:min-h-0"><input type="checkbox" className="h-5 w-5" checked={h.isClosed} onChange={(e) => set(d, { isClosed: e.target.checked })} />Closed</label></td>
                <td className="py-1.5 pr-1"><Input type="time" step={1800} aria-label={`${DAYS[d]} opens`} disabled={h.isClosed} value={h.openTime} onChange={(e) => set(d, { openTime: e.target.value })} className="h-9 text-sm" /></td>
                <td className="py-1.5"><Input type="time" step={1800} aria-label={`${DAYS[d]} closes`} disabled={h.isClosed} value={h.closeTime === "24:00" ? "23:59" : h.closeTime} onChange={(e) => set(d, { closeTime: e.target.value === "23:59" ? "24:00" : e.target.value })} className="h-9 text-sm" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <Alert className="mt-3">{error}</Alert>}
      {ok && <Alert tone="success" className="mt-3">{ok}</Alert>}
      <Button variant="dark" size="sm" className="mt-3" loading={busy} onClick={() => save({ hours })}>Save hours</Button>
    </section>
  );
}
