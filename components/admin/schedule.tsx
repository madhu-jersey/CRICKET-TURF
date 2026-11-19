"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookingDrawer } from "@/components/admin/booking-drawer";
import { BlockForm } from "@/components/admin/block-form";
import { cn } from "@/lib/utils";
import { addDays, dayOfWeek, formatMinutes, istToUtc, minutesToHHMM, timeToMinutes, relativeDayLabel, formatDateShort } from "@/lib/time";

type Court = { id: string; name: string; slotMinutes: number };
type Hours = { courtId: string; dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };
type B = { id: string; code: string; courtId: string; startAt: string; endAt: string; status: string; source: string; name: string };
type Blk = { id: string; courtId: string; startAt: string; endAt: string; reason: string; note: string | null };
type Col = { key: string; courtId: string; date: string; label: string; sub?: string };

const STATUS_CLS: Record<string, string> = {
  CONFIRMED: "bg-pitch-600 text-white",
  PENDING_PAYMENT: "bg-amber-300 text-amber-950 border border-dashed border-amber-700",
  COMPLETED: "bg-zinc-400 text-white",
  NO_SHOW: "bg-orange-400 text-white",
};

export function Schedule(props: { view: "day" | "week"; date: string; days: string[]; courts: Court[]; courtId: string; role: "OWNER" | "STAFF"; hours: Hours[]; bookings: B[]; blocks: Blk[]; today: string }) {
  const { view, date, days, courts, courtId, role, hours, bookings, blocks, today } = props;
  const router = useRouter();
  const [drawer, setDrawer] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ courtId: string; date: string; start: number; end: number } | null>(null);
  const [drag, setDrag] = useState<{ col: string; from: number; to: number } | null>(null);
  const dragging = useRef(false);
  // Phones: show one court at a time in day view, and use taps (not drags) on the grid.
  const [isPhone, setIsPhone] = useState(false);
  const [phoneCourt, setPhoneCourt] = useState(courts[0]?.id ?? "");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setIsPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const pointerType = useRef<string>("mouse");

  const allCols: Col[] =
    view === "day"
      ? courts.map((c) => ({ key: c.id, courtId: c.id, date, label: c.name }))
      : days.map((d) => ({ key: d, courtId, date: d, label: relativeDayLabel(d, today), sub: formatDateShort(istToUtc(d, 720)) }));
  const cols = isPhone && view === "day" ? allCols.filter((c) => c.courtId === phoneCourt) : allCols;
  const slotMin = 60;
  const hoursFor = (c: Col) => hours.find((h) => h.courtId === c.courtId && h.dayOfWeek === dayOfWeek(c.date));
  const opens = hours.filter((h) => !h.isClosed).map((h) => timeToMinutes(h.openTime));
  const closes = hours.filter((h) => !h.isClosed).map((h) => timeToMinutes(h.closeTime));
  const dayStart = opens.length ? Math.min(...opens) : 360;
  const dayEnd = closes.length ? Math.max(...closes) : 1380;
  const rows: number[] = [];
  for (let m = dayStart; m < dayEnd; m += slotMin) rows.push(m);
  const ROW_H = isPhone ? 54 : 44; // bigger tap targets on phones

  const minutesIn = (iso: string, d: string) => (new Date(iso).getTime() - istToUtc(d, 0).getTime()) / 60000;
  const occupied = (c: Col, m: number) => {
    const s = istToUtc(c.date, m).getTime();
    const e = s + slotMin * 60000;
    return [...bookings, ...blocks].some((x) => x.courtId === c.courtId && new Date(x.startAt).getTime() < e && new Date(x.endAt).getTime() > s);
  };
  const isOpen = (c: Col, m: number) => {
    const h = hoursFor(c);
    return !!h && !h.isClosed && m >= timeToMinutes(h.openTime) && m + slotMin <= timeToMinutes(h.closeTime);
  };
  const isPast = (c: Col, m: number) => istToUtc(c.date, m + slotMin).getTime() <= Date.now();

  useEffect(() => {
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setDrag((d) => {
        if (d) {
          const col = cols.find((c) => c.key === d.col)!;
          const a = Math.min(d.from, d.to);
          const b = Math.max(d.from, d.to);
          setMenu({ courtId: col.courtId, date: col.date, start: a, end: b + slotMin });
        }
        return null;
      });
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  });

  const nav = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ view, date, ...(view === "week" ? { court: courtId } : {}), ...patch });
    router.push(`/admin/schedule?${p}`);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-zinc-300 bg-white text-sm font-semibold">
          {(["day", "week"] as const).map((v) => (
            <button key={v} onClick={() => nav({ view: v, court: courtId })} aria-pressed={view === v} className={cn("min-h-11 min-w-14 px-3 md:min-h-0 md:py-1.5", view === v && "bg-ink text-white")}>
              {v === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <button onClick={() => nav({ date: addDays(date, view === "week" ? -7 : -1) })} className="min-h-11 min-w-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-semibold md:min-h-0 md:py-1.5" aria-label={view === "week" ? "Previous week" : "Previous day"}>←</button>
        <input type="date" value={date} onChange={(e) => e.target.value && nav({ date: e.target.value })} aria-label="Date" className="h-11 rounded-lg md:h-9 border border-zinc-300 bg-white px-2 text-sm" />
        <button onClick={() => nav({ date: addDays(date, view === "week" ? 7 : 1) })} className="min-h-11 min-w-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-semibold md:min-h-0 md:py-1.5" aria-label={view === "week" ? "Next week" : "Next day"}>→</button>
        <button onClick={() => nav({ date: today })} className="min-h-11 min-w-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-semibold md:min-h-0 md:py-1.5">Today</button>
        {view === "week" && (
          <select value={courtId} onChange={(e) => nav({ court: e.target.value })} aria-label="Court" className="h-11 rounded-lg md:h-9 border border-zinc-300 bg-white px-2 text-sm">
            {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <p className="ml-auto hidden text-xs text-zinc-500 md:block">Click an empty slot to add a walk-in{role === "OWNER" ? " or block it; drag down to block a range" : ""}.</p>
      </div>

      {isPhone && view === "day" && courts.length > 1 && (
        <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4" role="tablist" aria-label="Court">
          {courts.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={phoneCourt === c.id}
              onClick={() => setPhoneCourt(c.id)}
              className={cn("min-h-11 shrink-0 rounded-full border px-4 text-sm font-bold", phoneCourt === c.id ? "border-ink bg-ink text-flood" : "border-zinc-300 bg-white")}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <p className="mb-2 text-xs text-zinc-500 md:hidden">Tap a free time to add a walk-in{role === "OWNER" ? " or block it" : ""}. Tap a booking to manage it.</p>
      <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white" data-scroll-grid>
        <div className="grid select-none" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(${view === "week" ? 92 : 120}px, 1fr))` }}>
          <div className="sticky left-0 z-10 border-b border-zinc-200 bg-white" />
          {cols.map((c) => (
            <div key={c.key} className={cn("border-b border-l border-zinc-200 px-2 py-2 text-center text-sm font-bold", c.date === today && view === "week" && "bg-flood/30")}>
              {c.label}
              {c.sub && <span className="block text-xs font-normal text-zinc-500">{c.sub}</span>}
            </div>
          ))}
          <div className="sticky left-0 z-10 bg-white">
            {rows.map((m) => (
              <div key={m} style={{ height: ROW_H }} className="border-b border-zinc-100 pr-2 pt-1 text-right text-[11px] text-zinc-500">{formatMinutes(m)}</div>
            ))}
          </div>
          {cols.map((c) => {
            const items = [
              ...bookings.filter((b) => b.courtId === c.courtId).map((b) => ({ kind: "b" as const, ...b })),
              ...blocks.filter((b) => b.courtId === c.courtId).map((b) => ({ kind: "x" as const, ...b })),
            ]
              .map((x) => ({ x, top: minutesIn(x.startAt, c.date), bottom: minutesIn(x.endAt, c.date) }))
              .filter((p) => p.bottom > dayStart && p.top < dayEnd);
            return (
              <div key={c.key} className="relative border-l border-zinc-200" style={{ height: rows.length * ROW_H }}>
                {rows.map((m, i) => {
                  const open = isOpen(c, m);
                  const free = open && !occupied(c, m) && !isPast(c, m);
                  const inDrag = drag && drag.col === c.key && m >= Math.min(drag.from, drag.to) && m <= Math.max(drag.from, drag.to);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!free}
                      aria-label={free ? `${c.label} ${formatMinutes(m)} — free` : undefined}
                      tabIndex={free ? 0 : -1}
                      onPointerDown={(e) => {
                        pointerType.current = e.pointerType;
                        if (!free || role !== "OWNER" || e.button !== 0 || e.pointerType !== "mouse") return;
                        dragging.current = true;
                        setDrag({ col: c.key, from: m, to: m });
                      }}
                      onPointerEnter={() => {
                        if (dragging.current && drag?.col === c.key && free) setDrag({ ...drag, to: m });
                      }}
                      onClick={() => {
                        // Mouse owners use press-and-drag (handled on pointerup); taps and staff open the menu.
                        if (free && (role !== "OWNER" || pointerType.current !== "mouse")) setMenu({ courtId: c.courtId, date: c.date, start: m, end: m + slotMin });
                      }}
                      onKeyDown={(e) => {
                        if (free && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          setMenu({ courtId: c.courtId, date: c.date, start: m, end: m + slotMin });
                        }
                      }}
                      className={cn(
                        "absolute inset-x-0 block border-b border-zinc-100 transition",
                        !open && "bg-[repeating-linear-gradient(135deg,#f4f4f5_0_5px,#fff_5px_10px)]",
                        free && "hover:bg-flood/25",
                        inDrag && "bg-red-200",
                      )}
                      style={{ top: i * ROW_H, height: ROW_H }}
                    />
                  );
                })}
                {items.map(({ x, top, bottom }) => {
                  const t = Math.max(top, dayStart);
                  const bt = Math.min(bottom, dayEnd);
                  const style = { top: ((t - dayStart) / slotMin) * ROW_H + 2, height: ((bt - t) / slotMin) * ROW_H - 4 };
                  if (x.kind === "x") {
                    return (
                      <div key={x.id} className="absolute inset-x-1 overflow-hidden rounded-lg border border-red-300 bg-[repeating-linear-gradient(135deg,#fee2e2_0_6px,#fff5f5_6px_12px)] px-2 py-1 text-[11px] text-red-900" style={style} title={x.note ?? x.reason}>
                        <strong>Blocked</strong> · {x.reason.replace("_", " ").toLowerCase()}
                        {x.note && <span className="block truncate">{x.note}</span>}
                      </div>
                    );
                  }
                  return (
                    <button key={x.id} type="button" data-booking-id={x.id} onClick={() => setDrawer(x.id)} className={cn("absolute inset-x-1 overflow-hidden rounded-lg px-2 py-1 text-left text-[11px] shadow-sm hover:ring-2 hover:ring-ink", STATUS_CLS[x.status] ?? "bg-zinc-300")} style={style}>
                      <strong className="block truncate">{x.name}</strong>
                      <span className="block truncate opacity-90">{x.code} · {x.source === "ONLINE" ? "online" : x.source.toLowerCase().replace("_", "-")}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-600">
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-pitch-600" />Confirmed</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded border border-dashed border-amber-700 bg-amber-300" />Awaiting payment</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-zinc-400" />Completed</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-orange-400" />No-show</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded border border-red-300 bg-red-100" />Blocked</li>
      </ul>

      {menu && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center" onClick={(e) => e.target === e.currentTarget && setMenu(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="slot-menu-title" className="w-full max-w-md rounded-t-2xl bg-white p-5 sm:rounded-2xl">
            <h2 id="slot-menu-title" className="font-display text-2xl font-bold uppercase">
              {courts.find((c) => c.id === menu.courtId)?.name}
            </h2>
            <p className="text-sm text-zinc-600">{relativeDayLabel(menu.date, today)} {formatDateShort(istToUtc(menu.date, 720))} · {formatMinutes(menu.start)} – {formatMinutes(menu.end)}</p>
            <Link
              href={`/admin/walk-in?court=${menu.courtId}&date=${menu.date}&times=${Array.from({ length: (menu.end - menu.start) / slotMin }, (_, i) => minutesToHHMM(menu.start + i * slotMin)).join(",")}`}
              className="mt-4 block rounded-xl bg-ink px-4 py-3 text-center font-bold text-flood"
            >
              Create walk-in / phone booking
            </Link>
            {role === "OWNER" && (
              <div className="mt-4 border-t border-zinc-200 pt-4">
                <p className="mb-2 text-sm font-semibold">…or block this time</p>
                <BlockForm
                  compact
                  courts={courts}
                  initial={{ courtId: menu.courtId, startDate: menu.date, startTime: minutesToHHMM(menu.start), endTime: minutesToHHMM(menu.end) }}
                  onDone={() => {
                    setMenu(null);
                    router.refresh();
                  }}
                />
              </div>
            )}
            <button className="mt-2 min-h-11 w-full text-sm font-semibold underline" onClick={() => setMenu(null)}>Close</button>
          </div>
        </div>
      )}
      <BookingDrawer id={drawer} role={role} onClose={() => { setDrawer(null); router.refresh(); }} />
    </div>
  );
}
