"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { api, ApiError, cn } from "@/lib/utils";

type Target = { phone: string } | { bookingCode: string };
type SendRes = { maskedPhone: string; resendIn: number; devCode?: string };

/**
 * Sends a 6-digit OTP and verifies it. 6 boxes with auto-advance, backspace navigation,
 * paste support and a resend timer. On success the server sets the verified-phone cookie.
 */
export function OtpVerify({
  target,
  onVerified,
  onChangeNumber,
  autoSend = true,
  tone = "light",
}: {
  target: Target;
  onVerified: (maskedPhone: string) => void;
  onChangeNumber?: () => void;
  autoSend?: boolean;
  tone?: "light" | "dark";
}) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [sent, setSent] = useState<SendRes | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const started = useRef(false);
  const targetKey = JSON.stringify(target);

  const send = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const r = await api<SendRes>("/api/otp/send", { method: "POST", json: JSON.parse(targetKey) });
      setSent(r);
      setCooldown(r.resendIn);
      setDigits(Array(6).fill(""));
      setTimeout(() => inputs.current[0]?.focus(), 50);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [targetKey]);

  useEffect(() => {
    if (autoSend && !started.current) {
      started.current = true;
      void send();
    }
  }, [autoSend, send]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const verify = useCallback(
    async (code: string) => {
      if (verifying) return;
      setVerifying(true);
      setError(null);
      try {
        const r = await api<{ maskedPhone: string }>("/api/otp/verify", { method: "POST", json: { ...JSON.parse(targetKey), code } });
        onVerified(r.maskedPhone);
      } catch (e) {
        setError((e as Error).message);
        if (e instanceof ApiError && (e.code === "OTP_LOCKED" || e.code === "OTP_EXPIRED")) setCooldown(0);
        setDigits(Array(6).fill(""));
        setTimeout(() => inputs.current[0]?.focus(), 50);
      } finally {
        setVerifying(false);
      }
    },
    [onVerified, targetKey, verifying],
  );

  const setAt = (i: number, value: string) => {
    const clean = value.replace(/\D/g, "");
    if (clean.length > 1) {
      // paste or autofill of the whole code
      const next = clean.slice(0, 6).split("");
      const filled = Array(6).fill("").map((_, k) => next[k] ?? "");
      setDigits(filled);
      inputs.current[Math.min(next.length, 5)]?.focus();
      if (next.length === 6) void verify(next.join(""));
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) inputs.current[i + 1]?.focus();
    if (next.every((d) => d)) void verify(next.join(""));
  };

  const dark = tone === "dark";
  return (
    <div>
      {sent ? (
        <p className={cn("text-sm", dark ? "text-mist" : "text-zinc-600")}>
          Enter the 6-digit code sent to <strong className={dark ? "text-chalk" : "text-ink"}>{sent.maskedPhone}</strong>.
          {onChangeNumber && (
            <>
              {" "}
              <button type="button" onClick={onChangeNumber} className="font-semibold underline underline-offset-2">
                Change number
              </button>
            </>
          )}
        </p>
      ) : (
        <p className={cn("text-sm", dark ? "text-mist" : "text-zinc-600")}>{sending ? "Sending your code…" : "We'll send a 6-digit code to your phone."}</p>
      )}

      {sent?.devCode && (
        <div role="status" className="mt-3 rounded-xl border-2 border-dashed border-flood-dim bg-flood/15 px-4 py-2.5 text-sm text-current" data-testid="dev-otp">
          Demo mode — your code is <strong className="font-mono text-base tracking-[0.2em]" data-testid="dev-otp-code">{sent.devCode}</strong>
        </div>
      )}

      <fieldset className="mt-4" disabled={!sent || verifying}>
        <legend className="sr-only">One-time code</legend>
        <div className="flex gap-2 sm:gap-3" onPaste={(e) => { e.preventDefault(); setAt(0, e.clipboardData.getData("text")); }}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { inputs.current[i] = el; }}
              value={d}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={i === 0 ? 6 : 1}
              aria-label={`Digit ${i + 1}`}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !digits[i] && i > 0) inputs.current[i - 1]?.focus();
                if (e.key === "ArrowLeft" && i > 0) inputs.current[i - 1]?.focus();
                if (e.key === "ArrowRight" && i < 5) inputs.current[i + 1]?.focus();
              }}
              onFocus={(e) => e.target.select()}
              className={cn(
                "h-14 w-full min-w-0 max-w-14 rounded-xl border-2 text-center font-display text-3xl font-bold transition focus:outline-none focus:ring-4 disabled:opacity-60",
                dark ? "border-white/20 bg-pitch-850 text-chalk focus:border-flood focus:ring-flood/30" : "border-zinc-300 bg-white text-ink focus:border-pitch-600 focus:ring-flood/40",
                d && (dark ? "border-flood/70" : "border-pitch-600"),
              )}
            />
          ))}
        </div>
      </fieldset>

      {error && <Alert className="mt-4">{error}</Alert>}

      <div className="mt-4 flex items-center gap-3 text-sm">
        {verifying && <span className="font-semibold">Verifying…</span>}
        {!verifying && (
          <Button type="button" variant={dark ? "outline" : "light"} size="sm" onClick={send} disabled={cooldown > 0} loading={sending}>
            {sent ? (cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code") : "Send code"}
          </Button>
        )}
      </div>
    </div>
  );
}
