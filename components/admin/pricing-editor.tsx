"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Select } from "@/components/ui/field";
import { priceForSlot, type PricingRuleLite } from "@/lib/pricing";
import { cn, inr } from "@/lib/utils";
import { formatMinutes } from "@/lib/time";

type DayType = "WEEKDAY" | "WEEKEND" | "HOLIDAY";
type Rule = PricingRuleLite & { courtId: string };
type Band = { startTime: string; endTime: string; pricePerSlot: string };

export function PricingEditor({ courts, rules }: { courts: { id: string; name: string; sport: string }[]; rules: Rule[] }) {
  const router = useRouter();
  const [courtId, setCourtId] = useState(courts[0]?.id ?? "");
  const [dayType, setDayType] = useState<DayType>("WEEKDAY");
  const initialBands = (c: string, d: DayType): Band[] =>
    rules.filter((r) => r.courtId === c && r.dayType === d).map((r) => ({ startTime: r.startTime, endTime: r.endTime, pricePerSlot: String(r.pricePerSlot) }));
  const [bands, setBands] = useState<Band[]>(() => initialBands(courtId, dayType));
  const [applyToSport, setApplyToSport] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const pick = (c: string, d: DayType) => {
    setCourtId(c);
    setDayType(d);
    setBands(initialBands(c, d));
    setOk(null);
    setError(null);
  };

  // Live preview: the draft bands for this day type + saved rules for the others.
  const preview = useMemo(() => {
    const draft: PricingRuleLite[] = [
      ...rules.filter((r) => r.courtId === courtId && r.dayType !== dayType),
      ...bands.filter((b) => b.startTime && b.endTime && b.pricePerSlot !== "").map((b) => ({ dayType, startTime: b.startTime, endTime: b.endTime === "23:59" ? "24:00" : b.endTime, pricePerSlot: Number(b.pricePerSlot) })),
    ];
    const hours = Array.from({ length: 17 }, (_, i) => (i + 6) * 60);
    return (["WEEKDAY", "WEEKEND", "HOLIDAY"] as DayType[]).map((d) => ({ d, prices: hours.map((m) => ({ m, p: priceForSlot(draft, d, m) })) }));
  }, [bands, courtId, dayType, rules]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await adminApi<{ courts: number }>("/api/admin/pricing", {
        method: "PUT",
        json: { courtId, dayType, applyToSport, rules: bands.map((b) => ({ startTime: b.startTime, endTime: b.endTime === "23:59" ? "24:00" : b.endTime, pricePerSlot: Number(b.pricePerSlot) })) },
      });
      setOk(`Saved for ${r.courts} court${r.courts === 1 ? "" : "s"}. The public slot grid uses the new prices immediately.`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const court = courts.find((c) => c.id === courtId);
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3">
          <Select aria-label="Court" value={courtId} onChange={(e) => pick(e.target.value, dayType)} className="h-10 text-sm">
            {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select aria-label="Day type" value={dayType} onChange={(e) => pick(courtId, e.target.value as DayType)} className="h-10 text-sm">
            <option value="WEEKDAY">Weekday (Mon–Fri)</option>
            <option value="WEEKEND">Weekend (Sat–Sun)</option>
            <option value="HOLIDAY">Holiday</option>
          </Select>
        </div>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-zinc-500">
              <th scope="col" className="pb-2">From</th>
              <th scope="col" className="pb-2">To</th>
              <th scope="col" className="pb-2">₹ / slot</th>
              <th scope="col"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Input type="time" step={1800} aria-label={`Band ${i + 1} start`} value={b.startTime} onChange={(e) => setBands(bands.map((x, k) => (k === i ? { ...x, startTime: e.target.value } : x)))} className="h-10 text-sm" /></td>
                <td className="py-1 pr-2"><Input type="time" step={1800} aria-label={`Band ${i + 1} end`} value={b.endTime === "24:00" ? "23:59" : b.endTime} onChange={(e) => setBands(bands.map((x, k) => (k === i ? { ...x, endTime: e.target.value } : x)))} className="h-10 text-sm" /></td>
                <td className="py-1 pr-2"><Input type="number" min={0} aria-label={`Band ${i + 1} price`} value={b.pricePerSlot} onChange={(e) => setBands(bands.map((x, k) => (k === i ? { ...x, pricePerSlot: e.target.value } : x)))} className="h-10 text-sm" data-testid={`price-${i}`} /></td>
                <td className="py-1"><button type="button" onClick={() => setBands(bands.filter((_, k) => k !== i))} className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-bold text-red-700 md:min-h-0 md:min-w-0" aria-label={`Remove band ${i + 1}`}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {bands.length === 0 && <p className="mt-2 text-sm text-zinc-500">{dayType === "WEEKDAY" ? "No prices — slots will be unbookable." : `No ${dayType.toLowerCase()} prices — ${dayType === "HOLIDAY" ? "weekend" : "weekday"} prices apply.`}</p>}
        <button type="button" onClick={() => setBands([...bands, { startTime: "18:00", endTime: "23:59", pricePerSlot: "" }])} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline md:min-h-0">+ Add time band</button>
        <label className="mt-4 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={applyToSport} onChange={(e) => setApplyToSport(e.target.checked)} />Apply to all {court?.sport === "PICKLEBALL" ? "pickleball" : "cricket"} courts</label>
        {error && <Alert className="mt-3">{error}</Alert>}
        {ok && <Alert tone="success" className="mt-3">{ok}</Alert>}
        <Button variant="dark" className="mt-4" onClick={save} loading={busy} data-testid="save-pricing">Save {dayType.toLowerCase()} prices</Button>
      </section>
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-500">Live preview — {court?.name}</h2>
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr>
                <th scope="col" className="pr-2 text-left">Hour</th>
                {preview.map((p) => <th key={p.d} scope="col" className="px-2 text-right">{p.d.toLowerCase()}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview[0].prices.map((row, i) => (
                <tr key={row.m} className="border-t border-zinc-100">
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-zinc-600">{formatMinutes(row.m)}</th>
                  {preview.map((p) => {
                    const v = p.prices[i].p;
                    return <td key={p.d} className={cn("px-2 py-1 text-right tabular-nums", p.d === dayType && "bg-flood/25 font-bold", v === null && "text-red-600")}>{v === null ? "—" : inr(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
