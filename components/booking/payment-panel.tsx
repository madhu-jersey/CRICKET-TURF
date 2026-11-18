"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonClass } from "@/components/ui/button";
import { ClockIcon, ShieldIcon, XIcon } from "@/components/ui/icons";
import { api, ApiError, cn, inr } from "@/lib/utils";
import type { HoldResponse } from "@/lib/booking/service";
import { siteConfig } from "@/config/site";

type Order = NonNullable<HoldResponse["order"]>;
type CheckoutResult = { orderId: string; paymentId: string; signature: string };

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: unknown) => void): void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not open the payment page. Check your internet and try again."));
    document.body.appendChild(s);
  });
}

export function useCountdown(until: string | null) {
  const [left, setLeft] = useState(() => (until ? new Date(until).getTime() - Date.now() : 0));
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(new Date(until).getTime() - Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return Math.max(0, left);
}

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function HoldTimer({ until }: { until: string | null }) {
  const left = useCountdown(until);
  const urgent = left < 120_000;
  return (
    <div role="timer" aria-live="off" className={cn("flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors", urgent ? "bg-[#fff1ed] text-[#8a2410]" : "bg-pitch-900 text-chalk")}>
      <span className="flex items-center gap-2">
        <ClockIcon className={cn("size-5", urgent && "animate-pulse")} />
        Your slot is kept for you for
      </span>
      <span className="font-mono text-xl tabular-nums" data-testid="hold-timer">
        {mmss(left)}
      </span>
    </div>
  );
}

/**
 * Pays the advance for a held booking (Razorpay Checkout or the mock checkout). Both end in
 * POST /api/payments/verify, then the booking page shows the server's truth. With `autoStart`
 * the payment window opens immediately, so the customer taps once. Failure or closing the window
 * keeps the hold, and a big "Try again" restarts it.
 */
export function PaymentPanel({ hold, onExpired, autoStart = false }: { hold: HoldResponse; onExpired?: () => void; autoStart?: boolean }) {
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(hold.order);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "failed" | "closed" | "verifying" | "expired">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [mockOpen, setMockOpen] = useState(false);
  const left = useCountdown(hold.holdExpiresAt);
  const expiredRef = useRef(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    if (hold.holdExpiresAt && left <= 0 && !expiredRef.current && phase !== "verifying") {
      expiredRef.current = true;
      setPhase("expired");
      setMockOpen(false);
      onExpired?.();
    }
  }, [left, hold.holdExpiresAt, phase, onExpired]);

  const verify = useCallback(
    async (r: CheckoutResult) => {
      setPhase("verifying");
      setMessage(null);
      try {
        await api("/api/payments/verify", { method: "POST", json: r });
        try {
          sessionStorage.removeItem("bba-booking-form");
        } catch {
          /* ignore */
        }
        router.push(`/booking/${hold.bookingCode}?paid=1`);
        router.refresh();
      } catch (e) {
        setPhase("failed");
        setMessage(`${(e as Error).message} If money was cut from your account, your booking will be confirmed automatically or the money returned.`);
      }
    },
    [hold.bookingCode, router],
  );

  const fail = (reason: string) => {
    setOrder(null); // a failed order can't be reused; "Try again" asks for a fresh one
    setPhase("failed");
    setMessage(reason);
  };

  const pay = async () => {
    setBusy(true);
    setMessage(null);
    setPhase((p) => (p === "failed" || p === "closed" ? "idle" : p));
    try {
      let o = order;
      if (!o) {
        const fresh = await api<HoldResponse>(`/api/bookings/${hold.bookingCode}/pay`, { method: "POST" });
        if (!fresh.order) {
          router.push(`/booking/${hold.bookingCode}`);
          router.refresh();
          return;
        }
        o = fresh.order;
        setOrder(o);
      }
      if (o.provider === "mock") {
        setMockOpen(true);
        return;
      }
      await loadRazorpay();
      const rz = new window.Razorpay!({
        key: o.keyId,
        order_id: o.orderId,
        amount: o.amountPaise,
        currency: o.currency,
        name: siteConfig.name,
        description: `Advance for ${hold.bookingCode}`,
        prefill: { name: hold.prefill.name, contact: hold.prefill.phone },
        theme: { color: "#0b2a19" },
        handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
          void verify({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
        modal: { ondismiss: () => setPhase((p) => (p === "verifying" || p === "failed" ? p : "closed")) },
      });
      rz.on("payment.failed", () => fail("The bank did not accept the payment."));
      rz.open();
    } catch (e) {
      if (e instanceof ApiError && e.code === "HOLD_EXPIRED") {
        setPhase("expired");
        onExpired?.();
      } else setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoStart && !autoStarted.current && hold.holdExpiresAt) {
      autoStarted.current = true;
      void pay();
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const simulate = async (outcome: "success" | "failure") => {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api<CheckoutResult & { failed?: boolean; reason?: string }>("/api/payments/mock/simulate", { method: "POST", json: { orderId: order.orderId, outcome } });
      setMockOpen(false);
      if (r.failed) fail(r.reason ?? "The bank did not accept the payment.");
      else await verify(r);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === "expired") {
    return (
      <div className="animate-rise space-y-4 text-center" role="alert">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-amber-100 text-amber-800">
          <ClockIcon className="size-8" />
        </div>
        <h3 className="font-display text-2xl font-extrabold uppercase">Time is up</h3>
        <p className="text-sm text-zinc-600">
          We kept your slot for a few minutes, but the payment wasn&apos;t finished, so the slot is free again. If money was cut from your account, we&apos;ll confirm the booking or return the money automatically.
        </p>
        <a href="/book" className={buttonClass("dark", "lg", "w-full")}>Book again</a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <HoldTimer until={hold.holdExpiresAt} />
      {phase === "closed" && (
        <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900" role="status">
          You closed the payment page. Your slot is still kept — tap the button to pay.
        </p>
      )}
      {message && phase !== "failed" && <p className="rounded-xl bg-[#fff1ed] px-4 py-3 text-sm font-medium text-[#8a2410]" role="alert">{message}</p>}
      <Button size="lg" className="h-16 w-full text-lg" onClick={pay} loading={busy || phase === "verifying"} data-testid="pay-button">
        {phase === "verifying" ? "Confirming your payment…" : phase === "failed" || phase === "closed" ? `Try again · Pay ${inr(hold.advance)}` : `Pay ${inr(hold.advance)} now`}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-center text-sm text-zinc-600">
        <ShieldIcon className="size-4 text-pitch-600" /> Safe payment · UPI, cards, net banking
      </p>
      <p className="text-center text-sm text-zinc-600">
        Pay <strong>{inr(hold.advance)}</strong> now · <strong>{inr(hold.balance)}</strong> at the ground
      </p>

      {/* Payment failed: full-screen, one clear action */}
      {phase === "failed" && (
        <div className="fixed inset-0 z-[60] grid place-items-end bg-black/60 backdrop-blur-sm sm:place-items-center" role="alertdialog" aria-modal="true" aria-labelledby="fail-title" aria-describedby="fail-desc">
          <div className="w-full max-w-md animate-[sheet_.35s_cubic-bezier(.2,.9,.3,1)_both] rounded-t-[28px] bg-white px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-7 text-center text-ink shadow-2xl sm:rounded-[28px]">
            <div className="mx-auto grid size-20 animate-pop place-items-center rounded-full bg-[#ffe1d8] text-[#c2331a]">
              <XIcon className="size-10" strokeWidth={2.5} />
            </div>
            <h3 id="fail-title" className="mt-4 font-display text-3xl font-extrabold uppercase">Payment failed</h3>
            <div id="fail-desc" className="mt-2 space-y-2 text-[15px] text-zinc-600">
              <p>{message ?? "The payment did not go through."}</p>
              <p>
                <strong className="text-ink">Don&apos;t worry — your slot is still kept for {mmss(left)}.</strong>
              </p>
              <p className="text-sm">If money was cut from your account, it comes back automatically in 5–7 days.</p>
            </div>
            <Button size="lg" className="mt-6 h-16 w-full text-lg" onClick={pay} loading={busy} data-testid="retry-payment" autoFocus>
              Try again · {inr(hold.advance)}
            </Button>
            <a href={`tel:${siteConfig.phoneE164}`} className="mt-3 block py-2 text-sm font-semibold text-zinc-600 underline">
              Need help? Call {siteConfig.phoneDisplay}
            </a>
            <button type="button" onClick={() => setPhase("closed")} className="mt-1 w-full py-2 text-sm text-zinc-500">
              Close
            </button>
          </div>
        </div>
      )}

      {mockOpen && order && (
        <div className="fixed inset-0 z-[60] grid place-items-end bg-black/60 backdrop-blur-sm sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="mock-title">
          <div className="w-full max-w-sm animate-[sheet_.35s_cubic-bezier(.2,.9,.3,1)_both] rounded-t-[28px] bg-white p-6 pb-[max(env(safe-area-inset-bottom),24px)] text-ink shadow-2xl sm:rounded-[28px]">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Test payment page (demo)</p>
            <h2 id="mock-title" className="mt-1 font-display text-3xl font-extrabold uppercase">Pay {inr(order.amountPaise / 100)}</h2>
            <p className="mt-2 text-sm text-zinc-600">
              In the real site, the customer pays by UPI or card here. In the demo, choose what happens. Order <span className="font-mono text-xs">{order.orderId}</span>
            </p>
            <div className="mt-6 grid gap-3">
              <Button onClick={() => simulate("success")} loading={busy} className="h-14" data-testid="mock-success">Simulate success</Button>
              <Button variant="danger" onClick={() => simulate("failure")} disabled={busy} className="h-14" data-testid="mock-failure">Simulate failure</Button>
              <Button variant="light" onClick={() => { setMockOpen(false); setPhase("closed"); }} disabled={busy}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
