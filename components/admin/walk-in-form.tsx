"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";
import { cn, inr } from "@/lib/utils";
import type { Slot } from "@/lib/booking/slots";

export function WalkInForm({ courts, initial }: { courts: { id: string; name: string }[]; initial: { courtId?: string; date: string; times: string[] } }) {
  const [courtId, setCourtId] = useState(initial.courtId ?? "");
  const [date, setDate] = useState(initial.date);
  const [times, setTimes] = useState<string[]>(initial.times);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [source, setSource] = useState<"WALK_IN" | "PHONE">("WALK_IN");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"CASH" | "UPI" | "CARD">("CASH");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; id: string } | null>(null);

  const load = useCallback(async () => {
    if (!courtId || !date) return;
    setSlots(null);
    try {
      const r = await adminApi<{ slots: Slot[] }>(`/api/admin/availability?courtId=${courtId}&date=${date}`);
      setSlots(r.slots);
    } catch (e) {
      setError((e as Error).message);
      setSlots([]);
    }
  }, [courtId, date]);
  useEffect(() => void load(), [load]);

  const selected = useMemo(() => (slots ?? []).filter((s) => times.includes(s.time)), [slots, times]);
  const total = selected.reduce((a, b) => a + b.price, 0);

  const toggle = (s: Slot) => {
    if (s.state !== "AVAILABLE" || !slots) return;
    const idx = slots.indexOf(s);
    const sel = slots.map((x, i) => (times.includes(x.time) ? i : -1)).filter((i) => i >= 0);
    if (times.includes(s.time)) {
      if (idx === sel[0] || idx === sel[sel.length - 1]) setTimes(times.filter((t) => t !== s.time));
      else setTimes([s.time]);
    } else if (sel.length && (idx === sel[0] - 1 || idx === sel[sel.length - 1] + 1)) setTimes([...times, s.time]);
    else setTimes([s.time]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi<{ bookingCode: string; id: string }>("/api/admin/walk-in", {
        method: "POST",
        json: { courtId, date, times, name, phone, whatsappOptIn: optIn, source, amountReceived: Number(amount || 0), paymentMode: mode, notes: notes || undefined },
      });
      setDone({ code: r.bookingCode, id: r.id });
      setTimes([]);
      setName("");
      setPhone("");
      setAmount("");
      setNotes("");
      void load();
    } catch (err) {
      setError((err as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="wi-court">Court</Label>
            <Select id="wi-court" value={courtId} onChange={(e) => { setCourtId(e.target.value); setTimes([]); }} className="h-10 text-sm">
              {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="wi-date">Date</Label>
            <Input id="wi-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setTimes([]); }} className="h-10 text-sm" />
          </div>
        </div>
        <p className="mt-4 text-sm font-semibold">Slots <span className="font-normal text-zinc-500">(tap to select, tap next to extend)</span></p>
        {!slots && <div className="mt-2 h-32 animate-pulse rounded-xl bg-zinc-100" />}
        {slots && slots.length === 0 && <p className="mt-2 text-sm text-zinc-500">No slots for this date.</p>}
        <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {slots?.map((s) => {
            const sel = times.includes(s.time);
            return (
              <li key={s.time}>
                <button
                  type="button"
                  disabled={s.state !== "AVAILABLE"}
                  aria-pressed={sel}
                  data-time={s.time}
                  onClick={() => toggle(s)}
                  className={cn("h-14 w-full rounded-lg border text-xs", sel ? "border-ink bg-ink text-flood" : s.state === "AVAILABLE" ? "border-zinc-300 hover:border-ink" : "border-transparent bg-zinc-100 text-zinc-400")}
                >
                  <span className="block font-bold">{s.label}</span>
                  {s.state === "AVAILABLE" ? inr(s.price) : s.state.toLowerCase()}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        {done && <Alert tone="success">Booked <strong className="font-mono">{done.code}</strong>. <a className="underline" href={`/admin/bookings?q=${done.code}`}>View</a></Alert>}
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Source</legend>
          <label className="flex items-center gap-1.5"><input type="radio" checked={source === "WALK_IN"} onChange={() => setSource("WALK_IN")} />Walk-in</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={source === "PHONE"} onChange={() => setSource("PHONE")} />Phone</label>
        </fieldset>
        <div>
          <Label htmlFor="wi-name">Customer name</Label>
          <Input id="wi-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={50} className="h-10" />
        </div>
        <div>
          <Label htmlFor="wi-phone">Mobile (10 digits)</Label>
          <Input id="wi-phone" type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} required pattern="[6-9][0-9]{9}" className="h-10" />
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />Customer agreed to WhatsApp updates</label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="wi-amt">Amount received (₹)</Label>
            <Input id="wi-amt" type="number" min={0} max={total || undefined} value={amount} onChange={(e) => setAmount(e.target.value)} className="h-10" placeholder="0" />
          </div>
          <div>
            <Label htmlFor="wi-mode">Payment mode</Label>
            <Select id="wi-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="h-10 text-sm">
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="wi-notes">Notes</Label>
          <Input id="wi-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className="h-10" />
        </div>
        <div className="rounded-xl bg-zinc-50 p-3 text-sm">
          <div className="flex justify-between"><span>Total ({selected.length} hr)</span><strong>{inr(total)}</strong></div>
          <div className="flex justify-between text-zinc-600"><span>Balance after this</span><span>{inr(Math.max(0, total - Number(amount || 0)))}</span></div>
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="dark" size="lg" className="w-full" disabled={!selected.length} loading={busy} data-testid="walkin-submit">Create booking</Button>
      </section>
    </form>
  );
}
