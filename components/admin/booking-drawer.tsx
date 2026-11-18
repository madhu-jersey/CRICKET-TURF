"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";
import { StatusBadge } from "@/components/admin/shell";
import { inr } from "@/lib/utils";

type Detail = {
  booking: { id: string; bookingCode: string; startAt: string; endAt: string; status: string; totalAmount: number; discountAmount: number; advanceAmount: number; balanceAmount: number; balancePaidAt: string | null; refundAmount: number; source: string; cancelReason: string | null; notes: string | null; createdAt: string };
  customer: { name: string; phone: string; whatsappOptIn: boolean };
  courtName: string;
  sport: string;
  paid: number;
  payments: { id: string; provider: string; kind: string; amount: number; status: string; refundAmount: number; providerPaymentId: string | null; paidAt: string | null }[];
  messages: { id: string; template: string; status: string; createdAt: string }[];
};

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });

/** Side drawer with booking details + every row action. Used by the bookings list and the schedule. */
export function BookingDrawer({ id, onClose, role }: { id: string | null; onClose: () => void; role: "OWNER" | "STAFF" }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState("CASH");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundMode, setRefundMode] = useState<"FULL" | "PARTIAL" | "NONE">(role === "OWNER" ? "FULL" : "NONE");
  const [refundAmt, setRefundAmt] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      setD(await adminApi<Detail>(`/api/admin/bookings/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setD(null);
    setMsg(null);
    setCancelOpen(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  if (!id) return null;

  const act = async (action: string, extra: Record<string, unknown> = {}, done = "Done") => {
    setBusy(action);
    setError(null);
    setMsg(null);
    try {
      const r = await adminApi<{ refunded?: number; refundError?: string }>(`/api/admin/bookings/${id}`, { method: "POST", json: { action, ...extra } });
      setMsg(r.refundError ? `Cancelled, but refund failed: ${r.refundError}` : r.refunded ? `${done}. Refunded ${inr(r.refunded)}.` : done);
      setCancelOpen(false);
      await load();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const b = d?.booking;
  const started = b ? new Date(b.startAt).getTime() <= Date.now() : false;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-labelledby="drawer-title" className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">Booking</p>
            <h2 id="drawer-title" className="font-mono text-2xl font-bold">{b?.bookingCode ?? "…"}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold" autoFocus>Close</button>
        </div>
        {error && <Alert className="mt-4">{error}</Alert>}
        {msg && <Alert tone="success" className="mt-4">{msg}</Alert>}
        {!d && !error && <div className="mt-6 h-40 animate-pulse rounded-xl bg-zinc-100" />}
        {d && b && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusBadge status={b.status} />
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold">{b.source.replace("_", "-")}</span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="col-span-2"><dt className="text-zinc-500">When</dt><dd className="font-semibold">{fmt.format(new Date(b.startAt))} – {fmtT.format(new Date(b.endAt))}</dd></div>
              <div><dt className="text-zinc-500">Court</dt><dd className="font-semibold">{d.courtName}</dd></div>
              <div><dt className="text-zinc-500">Customer</dt><dd className="font-semibold">{d.customer.name}</dd></div>
              <div><dt className="text-zinc-500">Phone</dt><dd><a className="font-semibold underline" href={`tel:${d.customer.phone}`}>{d.customer.phone}</a></dd></div>
              <div><dt className="text-zinc-500">WhatsApp</dt><dd className="font-semibold">{d.customer.whatsappOptIn ? "Opted in" : "No"}</dd></div>
              <div><dt className="text-zinc-500">Total</dt><dd className="font-semibold">{inr(b.totalAmount)}{b.discountAmount > 0 && <span className="block text-xs text-emerald-700">after {inr(b.discountAmount)} new-customer discount</span>}</dd></div>
              <div><dt className="text-zinc-500">Collected (net)</dt><dd className="font-semibold">{inr(d.paid)}</dd></div>
              <div><dt className="text-zinc-500">Balance</dt><dd className="font-semibold">{b.balancePaidAt ? "Paid" : inr(b.balanceAmount)}</dd></div>
              <div><dt className="text-zinc-500">Refunded</dt><dd className="font-semibold">{inr(b.refundAmount)}</dd></div>
              {b.cancelReason && <div className="col-span-2"><dt className="text-zinc-500">Cancel reason</dt><dd>{b.cancelReason}</dd></div>}
              {b.notes && <div className="col-span-2"><dt className="text-zinc-500">Notes</dt><dd>{b.notes}</dd></div>}
            </dl>

            <div className="mt-6 space-y-3">
              {["CONFIRMED", "COMPLETED"].includes(b.status) && !b.balancePaidAt && b.balanceAmount > 0 && (
                <div className="flex gap-2">
                  <Select aria-label="Payment mode" value={mode} onChange={(e) => setMode(e.target.value)} className="h-10 w-28 text-sm">
                    <option value="CASH">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="CARD">Card</option>
                  </Select>
                  <Button variant="dark" size="sm" className="h-10 flex-1" loading={busy === "balance_paid"} onClick={() => act("balance_paid", { mode }, "Balance marked paid")}>
                    Mark balance {inr(b.balanceAmount)} paid
                  </Button>
                </div>
              )}
              {["CONFIRMED", "COMPLETED", "NO_SHOW"].includes(b.status) && started && (
                <div className="flex gap-2">
                  {b.status !== "COMPLETED" && <Button variant="light" size="sm" loading={busy === "complete"} onClick={() => act("complete", {}, "Marked completed")}>Mark completed</Button>}
                  {b.status !== "NO_SHOW" && <Button variant="light" size="sm" loading={busy === "no_show"} onClick={() => act("no_show", {}, "Marked no-show")}>Mark no-show</Button>}
                </div>
              )}
              {b.status === "CONFIRMED" && d.customer.whatsappOptIn && (
                <Button variant="light" size="sm" loading={busy === "resend"} onClick={() => act("resend", {}, "Confirmation queued on WhatsApp")}>Resend WhatsApp confirmation</Button>
              )}
              {["CONFIRMED", "PENDING_PAYMENT"].includes(b.status) && !cancelOpen && (
                <Button variant="danger" size="sm" onClick={() => setCancelOpen(true)}>Cancel booking…</Button>
              )}
              {cancelOpen && (
                <form
                  className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act("cancel", { refundMode, amount: refundMode === "PARTIAL" ? Number(refundAmt) : undefined, reason }, "Booking cancelled");
                  }}
                >
                  <fieldset>
                    <legend className="mb-2 text-sm font-semibold">Refund ({inr(d.paid)} collected)</legend>
                    {role !== "OWNER" && <p className="mb-2 text-xs text-zinc-600">Only the owner can give refunds.</p>}
                    {(role === "OWNER" ? (["FULL", "PARTIAL", "NONE"] as const) : (["NONE"] as const)).map((m) => (
                      <label key={m} className="mr-4 inline-flex items-center gap-1.5 text-sm">
                        <input type="radio" name="refund" value={m} checked={refundMode === m} onChange={() => setRefundMode(m)} />
                        {m === "FULL" ? "Full" : m === "PARTIAL" ? "Partial" : "No refund"}
                      </label>
                    ))}
                  </fieldset>
                  {refundMode === "PARTIAL" && (
                    <div>
                      <Label htmlFor="refund-amt">Refund amount (₹)</Label>
                      <Input id="refund-amt" type="number" min={0} max={d.paid} value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} required className="h-10" />
                    </div>
                  )}
                  <div>
                    <Label htmlFor="reason">Reason (sent to audit log)</Label>
                    <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="h-10" placeholder="e.g. Rain — ground unplayable" />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" variant="danger" size="sm" loading={busy === "cancel"}>Confirm cancel</Button>
                    <Button type="button" variant="light" size="sm" onClick={() => setCancelOpen(false)}>Back</Button>
                  </div>
                </form>
              )}
              {role === "OWNER" && ["CANCELLED", "EXPIRED", "NO_SHOW", "REFUNDED"].includes(b.status) && d.paid > 0 && (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act("refund", { amount: Number(refundAmt) }, "Refund issued");
                  }}
                >
                  <div className="flex-1">
                    <Label htmlFor="r2">Refund (max {inr(d.paid)})</Label>
                    <Input id="r2" type="number" min={1} max={d.paid} value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} required className="h-10" />
                  </div>
                  <Button type="submit" variant="dark" size="sm" className="h-10" loading={busy === "refund"}>Refund</Button>
                </form>
              )}
            </div>

            <h3 className="mt-8 text-sm font-bold uppercase tracking-wider text-zinc-500">Payments</h3>
            <ul className="mt-2 divide-y divide-zinc-100 text-sm">
              {d.payments.length === 0 && <li className="py-2 text-zinc-500">None</li>}
              {d.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-3 py-2">
                  <span>{p.kind.toLowerCase()} · {p.provider}{p.providerPaymentId ? <span className="block font-mono text-xs text-zinc-500">{p.providerPaymentId}</span> : null}</span>
                  <span className="text-right"><strong>{inr(p.amount)}</strong> <StatusBadge status={p.status} />{p.refundAmount > 0 && <span className="block text-xs text-sky-700">−{inr(p.refundAmount)} refunded</span>}</span>
                </li>
              ))}
            </ul>
            <h3 className="mt-6 text-sm font-bold uppercase tracking-wider text-zinc-500">Messages</h3>
            <ul className="mt-2 divide-y divide-zinc-100 text-sm">
              {d.messages.length === 0 && <li className="py-2 text-zinc-500">None</li>}
              {d.messages.map((m) => (
                <li key={m.id} className="flex justify-between py-2"><span>{m.template}</span><StatusBadge status={m.status} /></li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
