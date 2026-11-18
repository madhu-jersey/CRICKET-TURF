"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";

type Court = { id: string; name: string };

export function BlockForm({ courts, initial, onDone, compact }: { courts: Court[]; initial?: { courtId?: string; startDate?: string; startTime?: string; endTime?: string }; onDone?: () => void; compact?: boolean }) {
  const router = useRouter();
  const [courtId, setCourtId] = useState(initial?.courtId ?? courts[0]?.id ?? "");
  const [kind, setKind] = useState<"single" | "range" | "weekly">("single");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState(initial?.startTime ?? "06:00");
  const [endTime, setEndTime] = useState(initial?.endTime ?? "08:00");
  const [weeks, setWeeks] = useState("4");
  const [reason, setReason] = useState("MAINTENANCE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await adminApi<{ created: number }>("/api/admin/blocks", {
        method: "POST",
        json: { courtId, reason, note: note || undefined, startDate, startTime, endTime, endDate: kind === "range" ? endDate : undefined, repeatWeekly: kind === "weekly" ? Number(weeks) : undefined },
      });
      setOk(`Blocked ${r.created} time slot${r.created === 1 ? "" : "s"}.`);
      setNote("");
      router.refresh();
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      {!compact && (
        <>
          <div>
            <Label htmlFor="bf-court">Court</Label>
            <Select id="bf-court" value={courtId} onChange={(e) => setCourtId(e.target.value)} className="h-10 text-sm">
              {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-semibold">Type</legend>
            <div className="flex h-10 items-center gap-3 text-sm">
              {(["single", "range", "weekly"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1"><input type="radio" name="bf-kind" checked={kind === k} onChange={() => setKind(k)} />{k === "single" ? "One day" : k === "range" ? "Date range" : "Every week"}</label>
              ))}
            </div>
          </fieldset>
          <div>
            <Label htmlFor="bf-date">{kind === "range" ? "From" : kind === "weekly" ? "First date" : "Date"}</Label>
            <Input id="bf-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required className="h-10 text-sm" />
          </div>
          {kind === "range" && (
            <div>
              <Label htmlFor="bf-end">To</Label>
              <Input id="bf-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required className="h-10 text-sm" />
            </div>
          )}
          {kind === "weekly" && (
            <div>
              <Label htmlFor="bf-weeks">Repeat for (more weeks)</Label>
              <Input id="bf-weeks" type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(e.target.value)} required className="h-10 text-sm" />
            </div>
          )}
        </>
      )}
      <div>
        <Label htmlFor="bf-start">Start time</Label>
        <Input id="bf-start" type="time" step={1800} value={startTime} onChange={(e) => setStartTime(e.target.value)} required className="h-10 text-sm" />
      </div>
      <div>
        <Label htmlFor="bf-endt">End time</Label>
        <Input id="bf-endt" type="time" step={1800} value={endTime === "24:00" ? "23:59" : endTime} onChange={(e) => setEndTime(e.target.value === "23:59" ? "24:00" : e.target.value)} required className="h-10 text-sm" />
      </div>
      <div>
        <Label htmlFor="bf-reason">Reason</Label>
        <Select id="bf-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="h-10 text-sm">
          <option value="MAINTENANCE">Maintenance</option>
          <option value="TOURNAMENT">Tournament</option>
          <option value="PRIVATE_EVENT">Private event</option>
          <option value="OTHER">Other</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="bf-note">Note (optional)</Label>
        <Input id="bf-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className="h-10 text-sm" />
      </div>
      {error && <Alert className="sm:col-span-2">{error}</Alert>}
      {ok && <Alert tone="success" className="sm:col-span-2">{ok}</Alert>}
      <Button type="submit" variant="danger" loading={busy} className="sm:col-span-2" data-testid="block-submit">Block time</Button>
    </form>
  );
}
