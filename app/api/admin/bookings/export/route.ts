import { adminRoute } from "@/lib/admin/route";
import { searchBookings } from "@/lib/admin/reports";
import { formatDate, formatTimeRange, istDateKey } from "@/lib/time";

const esc = (v: unknown) => {
  const s = String(v ?? "");
  // Neutralise spreadsheet formula injection and quote everything.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const GET = adminRoute("STAFF", async (req) => {
  const u = new URL(req.url).searchParams;
  const { rows } = await searchBookings(
    { q: u.get("q") ?? undefined, from: u.get("from") ?? undefined, to: u.get("to") ?? undefined, sport: u.get("sport") ?? undefined, court: u.get("court") ?? undefined, status: u.get("status") ?? undefined, source: u.get("source") ?? undefined },
    { all: true },
  );
  const header = ["Code", "Date", "Time", "Sport", "Court", "Customer", "Phone", "Status", "Source", "Total", "Advance", "Balance", "Balance paid", "Refunded", "Created"];
  const lines = rows.map((r) =>
    [r.code, formatDate(r.startAt), formatTimeRange(r.startAt, r.endAt), r.sport, r.court, r.name, r.phone, r.status, r.source, r.total, r.advance, r.balance, r.balancePaidAt ? "yes" : "no", r.refund, r.createdAt.toISOString()].map(esc).join(","),
  );
  const csv = "﻿" + [header.map(esc).join(","), ...lines].join("\r\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="bookings-${istDateKey(new Date())}.csv"`, "Cache-Control": "no-store" },
  });
});
