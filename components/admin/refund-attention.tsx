"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { inr } from "@/lib/utils";

type Row = { id: string; bookingCode: string; pending: number; since: string | null; attempts: number; name: string };

/**
 * Overview card: refunds the system gave up retrying (24 h or 20 attempts). The owner refunds them
 * from the Razorpay dashboard, then records it here. [SEC-49]
 */
export function RefundAttention({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (!rows.length) return null;
  return (
    <section className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 sm:p-5" data-testid="refund-attention">
      <h2 className="font-display text-xl font-bold uppercase">Refunds needing attention</h2>
      <p className="mt-1 text-sm text-zinc-700">
        These refunds failed again and again, so automatic retries stopped. Refund each one from the Razorpay dashboard, then press
        &ldquo;Mark refunded&rdquo;.
      </p>
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3">
            <div className="min-w-0">
              <p className="font-mono text-sm font-bold">{r.bookingCode}</p>
              <p className="text-sm text-zinc-600">
                {r.name} · <strong>{inr(r.pending)}</strong> · {r.attempts} attempts
                {r.since ? ` · since ${new Date(r.since).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}
              </p>
            </div>
            <Button
              variant="dark"
              className="min-h-11"
              loading={busy === r.id}
              data-testid={`mark-refunded-${r.bookingCode}`}
              onClick={async () => {
                if (!window.confirm(`Have you refunded ${inr(r.pending)} for ${r.bookingCode} in the Razorpay dashboard?`)) return;
                setBusy(r.id);
                setMsg(null);
                try {
                  await adminApi(`/api/admin/bookings/${r.id}`, { method: "POST", json: { action: "mark_refunded_manually" } });
                  setMsg({ tone: "success", text: `${r.bookingCode} recorded as refunded.` });
                  router.refresh();
                } catch (e) {
                  setMsg({ tone: "error", text: (e as Error).message });
                } finally {
                  setBusy(null);
                }
              }}
            >
              Mark refunded
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
