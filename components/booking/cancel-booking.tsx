"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { OtpVerify } from "@/components/booking/otp-verify";
import { api, ApiError, inr } from "@/lib/utils";

/**
 * Cancel button for the booking page. Asks for an OTP first if this browser hasn't verified the owner's
 * phone. A cancel that refunds money always asks for a new code, even on a remembered device. [SEC-43]
 */
export function CancelBooking({
  bookingCode,
  refund,
  paid,
  policy,
  canCancel,
  verified,
}: {
  bookingCode: string;
  refund: number;
  paid: number;
  /** Policy sentence generated from Settings (lib/policy). */
  policy: string;
  canCancel: boolean;
  verified: boolean;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "otp" | "confirm" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [needFresh, setNeedFresh] = useState(refund > 0);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ refunded: number; refundError?: string }>(`/api/bookings/${bookingCode}/cancel`, { method: "POST" });
      setResult(
        r.refundError
          ? "Booking cancelled. The refund didn't go through yet — we'll keep retrying automatically. You can check this page for the refund status."
          : r.refunded > 0
            ? `Booking cancelled. ${inr(r.refunded)} will be refunded to your original payment method in 5–7 working days.`
            : "Booking cancelled.",
      );
      setStage("done");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.code === "PHONE_NOT_VERIFIED" || e.code === "FORBIDDEN" || e.code === "FRESH_OTP_REQUIRED")) {
        if (e.code === "FRESH_OTP_REQUIRED") setNeedFresh(true);
        setStage("otp");
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (stage === "done") return <Alert tone="success">{result}</Alert>;

  return (
    <div className="rounded-2xl border border-zinc-200 p-5">
      <h2 className="font-display text-xl font-bold uppercase">Need to cancel?</h2>
      <p className="mt-1 text-sm text-zinc-600" data-testid="cancel-policy">{policy}</p>
      <p className="mt-1 text-sm font-semibold text-zinc-800">
        {!canCancel
          ? "Online cancelling has closed for this booking. Please call the venue."
          : refund > 0
            ? `Cancel now and get ${inr(refund)} back.`
            : paid > 0
              ? `If you cancel now, the advance of ${inr(paid)} is not refunded.`
              : "This booking has no online payment to refund."}
      </p>
      {stage === "idle" && canCancel && (
        <Button variant="light" className="mt-4" onClick={() => setStage(verified && !needFresh ? "confirm" : "otp")}>
          Cancel booking
        </Button>
      )}
      {stage === "otp" && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold">
            {needFresh ? "To send your refund, confirm it's you with a new code." : "First, confirm it’s you."}
          </p>
          <OtpVerify target={{ bookingCode }} fresh={needFresh} onVerified={() => { setError(null); setStage("confirm"); }} />
        </div>
      )}
      {stage === "confirm" && (
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="danger" onClick={cancel} loading={busy} data-testid="confirm-cancel">
            Yes, cancel{refund > 0 ? ` & refund ${inr(refund)}` : ""}
          </Button>
          <Button variant="light" onClick={() => setStage("idle")} disabled={busy}>
            Keep booking
          </Button>
        </div>
      )}
      {error && <Alert className="mt-4">{error}</Alert>}
    </div>
  );
}
