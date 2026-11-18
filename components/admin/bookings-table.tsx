"use client";

import { useState } from "react";
import { BookingDrawer } from "@/components/admin/booking-drawer";
import { StatusBadge } from "@/components/admin/shell";
import { inr } from "@/lib/utils";

type Row = { id: string; code: string; startAt: string; endAt: string; status: string; source: string; total: number; balance: number; balancePaidAt: string | null; name: string; phone: string; court: string };

/** Statuses where a balance can still be owed at the venue. */
const LIVE = ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED"];

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function BookingsTable({ rows, role }: { rows: Row[]; role: "OWNER" | "STAFF" }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {/* Phones: one tappable card per booking */}
      <ul className="space-y-2 md:hidden">
        {rows.length === 0 && <li className="rounded-2xl border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500">No bookings match these filters.</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpen(r.id)} className="tap w-full rounded-2xl border border-zinc-200 bg-white p-4 text-left transition active:scale-[0.99]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-bold">{r.name}</p>
                  <p className="text-sm text-zinc-600">{fmt.format(new Date(r.startAt))} · {r.court}</p>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="font-mono text-xs text-zinc-500">{r.code} · {r.source.replace("_", "-").toLowerCase()}</span>
                <span className="font-semibold tabular-nums">
                  {inr(r.total)}{" "}
                  {!LIVE.includes(r.status) ? null : r.balancePaidAt || r.balance === 0 ? <span className="text-emerald-700">· paid</span> : <span className="text-amber-700">· due {inr(r.balance)}</span>}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-2xl border border-zinc-200 bg-white md:block">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-3">Code</th>
              <th scope="col" className="px-4 py-3">When</th>
              <th scope="col" className="px-4 py-3">Court</th>
              <th scope="col" className="px-4 py-3">Customer</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3 text-right">Total</th>
              <th scope="col" className="px-4 py-3 text-right">Balance</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-zinc-500">No bookings match these filters.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-zinc-50">
                <td className="px-4 py-3 font-mono text-xs">{r.code}<span className="block font-sans text-[11px] text-zinc-500">{r.source.replace("_", "-").toLowerCase()}</span></td>
                <td className="px-4 py-3">{fmt.format(new Date(r.startAt))}</td>
                <td className="px-4 py-3">{r.court}</td>
                <td className="px-4 py-3">{r.name}<span className="block text-xs text-zinc-500">{r.phone}</span></td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-3 text-right tabular-nums">{inr(r.total)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{!LIVE.includes(r.status) ? <span className="text-zinc-400">—</span> : r.balancePaidAt || r.balance === 0 ? <span className="text-emerald-700">paid</span> : inr(r.balance)}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setOpen(r.id)} className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-bold hover:border-ink">Manage</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BookingDrawer id={open} onClose={() => setOpen(null)} role={role} />
    </>
  );
}
