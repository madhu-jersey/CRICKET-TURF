"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label } from "@/components/ui/field";
import { OtpVerify } from "@/components/booking/otp-verify";
import { api, ApiError, inr } from "@/lib/utils";
import { siteConfig, type SportKey } from "@/config/site";

type Row = { bookingCode: string; startAt: string; endAt: string; status: string; totalAmount: number; courtName: string; sport: SportKey };

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const LABEL: Record<string, string> = { PENDING_PAYMENT: "Awaiting payment", CONFIRMED: "Confirmed", COMPLETED: "Completed", EXPIRED: "Expired", CANCELLED: "Cancelled", REFUNDED: "Refunded", NO_SHOW: "No-show" };

export function MyBookings() {
  const [stage, setStage] = useState<"loading" | "phone" | "otp" | "list">("loading");
  const [phone, setPhone] = useState("");
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ bookings: Row[] }>("/api/my-bookings");
      setRows(r.bookings);
      setStage("list");
    } catch (e) {
      if (e instanceof ApiError && e.code === "PHONE_NOT_VERIFIED") setStage("phone");
      else {
        setError((e as Error).message);
        setStage("phone");
      }
    }
  }, []);

  useEffect(() => void load(), [load]);

  const [optIn, setOptIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (stage === "list") void api<{ optIn: boolean }>("/api/my-bookings/whatsapp").then((r) => setOptIn(r.optIn)).catch(() => {});
  }, [stage]);
  const toggleWhatsapp = async () => {
    if (optIn === null) return;
    const r = await api<{ optIn: boolean }>("/api/my-bookings/whatsapp", { method: "POST", json: { optIn: !optIn } }).catch(() => null);
    if (r) setOptIn(r.optIn);
  };

  const signOut = async () => {
    await api("/api/session/phone", { method: "DELETE" }).catch(() => {});
    setRows([]);
    setPhone("");
    setStage("phone");
  };

  if (stage === "loading") return <div className="h-40 animate-pulse rounded-3xl bg-white/10" />;

  if (stage === "list") {
    const now = Date.now();
    const upcoming = rows.filter((r) => new Date(r.endAt).getTime() > now && ["CONFIRMED", "PENDING_PAYMENT"].includes(r.status)).reverse();
    const past = rows.filter((r) => !upcoming.includes(r));
    const List = ({ items, empty }: { items: Row[]; empty: string }) =>
      items.length === 0 ? (
        <p className="rounded-2xl border border-white/10 px-5 py-6 text-mist">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((r) => (
            <li key={r.bookingCode}>
              <Link href={`/booking/${r.bookingCode}`} className="flex items-center justify-between gap-4 rounded-2xl bg-white p-4 text-ink transition hover:ring-4 hover:ring-flood/50">
                <div>
                  <p className="font-display text-xl font-bold uppercase">{siteConfig.sports[r.sport].label} · {r.courtName}</p>
                  <p className="text-sm text-zinc-600">{fmt.format(new Date(r.startAt))}</p>
                  <p className="font-mono text-xs text-zinc-500">{r.bookingCode}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold">{LABEL[r.status] ?? r.status}</p>
                  <p className="text-sm text-zinc-600">{inr(r.totalAmount)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      );
    return (
      <div className="space-y-10">
        <section>
          <h2 className="mb-3 font-display text-2xl font-bold uppercase">Upcoming</h2>
          <List items={upcoming} empty="No upcoming bookings." />
        </section>
        <section>
          <h2 className="mb-3 font-display text-2xl font-bold uppercase">Past &amp; cancelled</h2>
          <List items={past} empty="Nothing here yet." />
        </section>
        {optIn !== null && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 px-4 py-3 text-sm">
            <span>WhatsApp booking messages: <strong>{optIn ? "On" : "Off"}</strong></span>
            <button className="font-semibold text-flood underline" onClick={toggleWhatsapp}>{optIn ? "Stop messages" : "Turn on"}</button>
          </div>
        )}
        <div className="flex gap-3">
          <Link href="/book" className="font-semibold text-flood underline">Book another slot</Link>
          <button className="text-sm text-mist underline" onClick={signOut}>Use a different number</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl bg-white p-6 text-ink sm:p-8">
      {error && <Alert className="mb-4">{error}</Alert>}
      {stage === "phone" && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^[6-9]\d{9}$/.test(phone)) return setPhoneErr("Enter a valid 10-digit Indian mobile number.");
            setPhoneErr(null);
            setStage("otp");
          }}
        >
          <Label htmlFor="mb-phone">Mobile number used for booking</Label>
          <div className="flex">
            <span className="grid h-12 place-items-center rounded-l-xl border border-r-0 border-zinc-300 bg-zinc-50 px-3 font-semibold text-zinc-600">+91</span>
            <Input id="mb-phone" type="tel" inputMode="numeric" autoComplete="tel-national" className="rounded-l-none" value={phone} maxLength={10} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} aria-invalid={!!phoneErr} aria-describedby={phoneErr ? "mb-err" : undefined} />
          </div>
          <FieldError id="mb-err">{phoneErr}</FieldError>
          <Button type="submit" variant="dark" size="lg" className="mt-5 w-full">Send code</Button>
        </form>
      )}
      {stage === "otp" && <OtpVerify target={{ phone: `+91${phone}` }} onVerified={() => void load()} onChangeNumber={() => setStage("phone")} />}
    </div>
  );
}
