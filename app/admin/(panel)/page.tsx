import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { overview } from "@/lib/admin/reports";
import { otpCapUsage } from "@/lib/otp-service";
import { Card, PageHeader } from "@/components/admin/shell";
import { formatTimeRange, formatDateShort, istToUtc, formatWeekday } from "@/lib/time";
import { inr } from "@/lib/utils";

export const metadata = { title: "Overview" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function OverviewPage() {
  await requireAdminPage("OWNER");
  const [o, otp] = await Promise.all([overview(), otpCapUsage()]);
  const maxRev = Math.max(1, ...o.revenueByDay.map((d) => d.advance + d.balance));
  const maxHeat = Math.max(1, ...o.heat.flat());
  const weekTotal = o.revenueByDay.reduce((s, d) => s + d.advance + d.balance, 0);

  return (
    <>
      <PageHeader title="Overview">
        <Link href="/admin/walk-in" className="inline-flex min-h-11 items-center rounded-full bg-ink px-4 text-sm font-bold text-flood md:min-h-0 md:py-2">+ Walk-in booking</Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><p className="text-sm text-zinc-500">Bookings today</p><p className="mt-1 font-display text-4xl font-bold" data-testid="kpi-today">{o.todayCount}</p></Card>
        <Card><p className="text-sm text-zinc-500">Revenue today</p><p className="mt-1 font-display text-4xl font-bold">{inr(o.todayAdvance + o.todayBalance)}</p><p className="text-xs text-zinc-500">{inr(o.todayAdvance)} advance · {inr(o.todayBalance)} balance</p></Card>
        <Card><p className="text-sm text-zinc-500">Last 7 days</p><p className="mt-1 font-display text-4xl font-bold">{inr(weekTotal)}</p></Card>
        <Card>
          <p className="text-sm text-zinc-500">Occupancy today</p>
          <ul className="mt-2 space-y-1.5">
            {o.occupancy.map((c) => (
              <li key={c.court} className="text-xs">
                <div className="flex justify-between"><span>{c.court}</span><span className="font-bold">{c.pct}%</span></div>
                <div className="mt-0.5 h-1.5 rounded-full bg-zinc-100"><div className="h-full rounded-full bg-pitch-600" style={{ width: `${Math.min(100, c.pct)}%` }} /></div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Revenue — last 7 days">
          <figure>
            <div className="flex h-48 items-end gap-2" role="img" aria-label={`Revenue for the last 7 days, total ${inr(weekTotal)}`}>
              {o.revenueByDay.map((d) => {
                const total = d.advance + d.balance;
                return (
                  <div key={d.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[11px] font-semibold tabular-nums text-zinc-600">{total ? `₹${(total / 1000).toFixed(1)}k` : ""}</span>
                    <div className="flex w-full max-w-12 flex-col justify-end overflow-hidden rounded-t-md" style={{ height: `${(total / maxRev) * 80}%`, minHeight: total ? 4 : 0 }} title={`${d.date}: ${inr(total)}`}>
                      <div className="bg-flood-dim" style={{ flex: d.balance || 0.0001 }} />
                      <div className="bg-pitch-600" style={{ flex: d.advance || 0.0001 }} />
                    </div>
                    <span className="text-[11px] text-zinc-500">{formatWeekday(istToUtc(d.date, 720))}</span>
                  </div>
                );
              })}
            </div>
            <figcaption className="mt-3 flex gap-4 text-xs text-zinc-600">
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-pitch-600" />Advance (online/at booking)</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-flood-dim" />Balance at venue</span>
            </figcaption>
          </figure>
        </Card>
        <Card title="Next up">
          {o.upcoming.length === 0 && <p className="text-sm text-zinc-500">No upcoming confirmed bookings.</p>}
          <ul className="divide-y divide-zinc-100">
            {o.upcoming.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-semibold">{b.name}</p>
                  <p className="text-zinc-500">{b.court} · {formatDateShort(b.startAt)}, {formatTimeRange(b.startAt, b.endAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs">{b.code}</p>
                  <p className="text-xs text-zinc-500">{b.balancePaidAt ? "paid" : `due ${inr(b.balance)}`}</p>
                </div>
              </li>
            ))}
          </ul>
          <Link href="/admin/schedule" className="mt-2 inline-block text-sm font-semibold underline">Open schedule →</Link>
        </Card>
      </div>

      <Card title="OTP codes sent today" className="mt-4">
        <div className="grid gap-3 sm:grid-cols-2" data-testid="otp-usage">
          {(["new", "returning"] as const).map((pool) => {
            const u = otp[pool];
            const pct = Math.min(100, Math.round((u.used / Math.max(1, u.cap)) * 100));
            return (
              <div key={pool}>
                <div className="flex justify-between text-sm">
                  <span>{pool === "new" ? "New numbers" : "Returning customers"}</span>
                  <span className="font-bold tabular-nums">{u.used} / {u.cap}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-zinc-100">
                  <div className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-pitch-600"}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-500">Each pool pauses when full. Raise today&apos;s limit in Settings if it&apos;s real demand.</p>
      </Card>

      <Card title="Busiest hours — last 4 weeks" className="mt-4">
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-[11px]">
            <thead>
              <tr>
                <th scope="col" className="sr-only">Day</th>
                {Array.from({ length: 17 }, (_, i) => i + 6).map((h) => (
                  <th key={h} scope="col" className="w-8 font-normal text-zinc-500">{h % 12 === 0 ? 12 : h % 12}{h < 12 ? "a" : "p"}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <tr key={d}>
                  <th scope="row" className="pr-2 text-left font-semibold text-zinc-600">{DAYS[d]}</th>
                  {Array.from({ length: 17 }, (_, i) => i + 6).map((h) => {
                    const v = o.heat[d][h];
                    return (
                      <td key={h} title={`${DAYS[d]} ${h}:00 — ${v} booking${v === 1 ? "" : "s"}`} className="h-6 w-8 rounded text-center tabular-nums" style={{ background: v ? `rgb(26 77 48 / ${0.15 + (v / maxHeat) * 0.85})` : "#f4f4f5", color: v / maxHeat > 0.5 ? "#fff" : "#3f3f46" }}>
                        {v || ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
