"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { siteConfig, type SportKey } from "@/config/site";
import { Button } from "@/components/ui/button";
import { Alert, Input } from "@/components/ui/field";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { CalendarIcon, CheckIcon, ClockIcon, CourtIcon, CricketIcon, GiftIcon, MoonIcon, PaddleIcon, PhoneIcon, ShieldIcon, SunIcon, SunriseIcon, SunsetIcon, UserIcon } from "@/components/ui/icons";
import { OtpVerify } from "@/components/booking/otp-verify";
import { PaymentPanel } from "@/components/booking/payment-panel";
import { priceBreakdown } from "@/lib/pricing";
import { api, ApiError, cn, inr } from "@/lib/utils";
import type { HoldResponse } from "@/lib/booking/service";
import type { Slot } from "@/lib/booking/slots";

export type FormCourt = { id: string; name: string; sport: SportKey };
export type FormDate = { key: string; label: string; sub: string };
/** policy: one sentence generated from Settings by lib/policy (never hardcoded here). */
export type FormSettings = { advanceType: "FIXED" | "PERCENT"; advanceValue: number; policy: string; holdMinutes: number; offerPercent: number };

type State = {
  sport: SportKey | null;
  date: string | null;
  courtId: string | null;
  times: string[];
  hours: number;
  name: string;
  phone: string; // 10 digits
  optIn: boolean;
  terms: boolean;
  idempotencyKey: string;
  hold: HoldResponse | null;
  /** Set when the server's amounts differ from what the grid showed (price edited meanwhile). [SEC-61] */
  priceChange?: { total: number; advance: number } | null;
};

const STORAGE_KEY = "bba-booking-form";
const PHONE_RE = /^[6-9]\d{9}$/;
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const PERIODS = [
  { key: "morning", label: "Morning", Icon: SunriseIcon, test: (h: number) => h < 12 },
  { key: "afternoon", label: "Afternoon", Icon: SunIcon, test: (h: number) => h >= 12 && h < 16 },
  { key: "evening", label: "Evening", Icon: SunsetIcon, test: (h: number) => h >= 16 && h < 19 },
  { key: "night", label: "Night (lights on)", Icon: MoonIcon, test: (h: number) => h >= 19 },
] as const;

const SPORT_ICON: Record<SportKey, typeof CricketIcon> = { CRICKET: CricketIcon, PICKLEBALL: PaddleIcon };

function Step({ n, title, icon: Icon, done, id, innerRef, children }: { n: number; title: string; icon: typeof CricketIcon; done?: boolean; id: string; innerRef?: React.Ref<HTMLElement>; children: React.ReactNode }) {
  return (
    <section ref={innerRef} aria-labelledby={id} className="scroll-mt-24 border-b border-zinc-100 py-7 first:pt-1 last:border-0 last:pb-1">
      <h2 id={id} className="mb-4 flex items-center gap-3 font-display text-[26px] font-extrabold uppercase leading-none">
        <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full text-base transition-colors duration-300", done ? "bg-pitch-600 text-white" : "bg-ink text-flood")}>
          {done ? <CheckIcon className="size-5 animate-pop" strokeWidth={3} /> : n}
        </span>
        <span className="flex-1">{title}</span>
        <Icon aria-hidden className="size-6 text-zinc-300" />
      </h2>
      {children}
    </section>
  );
}

/**
 * One-page booking designed to be obvious for anyone: big picture buttons, plain words, times
 * grouped by part of the day, the page scrolls to the next step by itself, and one big button at
 * the bottom always says what to do next. Prices/discounts shown are previews; the server
 * recomputes everything when the slot is held.
 */
export function BookingForm({
  courts,
  dates,
  settings,
  fromPrices,
  initial,
}: {
  courts: FormCourt[];
  dates: FormDate[];
  settings: FormSettings;
  fromPrices: Partial<Record<SportKey, number>>;
  initial: { sport?: SportKey; courtId?: string; date?: string; time?: string };
}) {
  const courtsFor = useCallback((sp: SportKey | null) => courts.filter((c) => c.sport === sp), [courts]);

  const fresh = useCallback((): State => {
    const sport = initial.sport ?? "CRICKET";
    const sc = courtsFor(sport);
    const courtId = initial.courtId && sc.some((c) => c.id === initial.courtId) ? initial.courtId : sc[0]?.id ?? null;
    const date = initial.date && dates.some((d) => d.key === initial.date) ? initial.date : dates[0]?.key ?? null;
    return { sport, date, courtId, times: initial.time ? [initial.time] : [], hours: 1, name: "", phone: "", optIn: true, terms: false, idempotencyKey: newKey(), hold: null };
  }, [courtsFor, dates, initial]);

  const [s, setS] = useState<State>(fresh);
  const [restored, setRestored] = useState(false);
  const update = (patch: Partial<State>) => setS((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw && !initial.sport) {
        const saved = JSON.parse(raw) as State;
        const alive = saved.hold?.holdExpiresAt && new Date(saved.hold.holdExpiresAt).getTime() > Date.now();
        if (!alive) saved.hold = null;
        if (!saved.date || !dates.some((d) => d.key === saved.date)) {
          saved.date = dates[0]?.key ?? null;
          saved.times = [];
        }
        setS({ ...saved, hours: saved.hours || Math.max(1, saved.times.length), terms: false });
      }
    } catch {
      /* storage unavailable */
    }
    setRestored(true);
  }, [dates, initial.sport]);

  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s, restored]);

  const sportCourts = courtsFor(s.sport);
  const court = courts.find((c) => c.id === s.courtId) ?? null;
  const locked = !!s.hold;

  // Section refs + gentle auto-scroll to the next step after each choice.
  const dateRef = useRef<HTMLElement>(null);
  const courtRef = useRef<HTMLElement>(null);
  const timeRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const payRef = useRef<HTMLElement>(null);
  const goTo = (ref: React.RefObject<HTMLElement | null>, delay = 220) =>
    setTimeout(() => ref.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), delay);

  // ── Verified phone + offer ──
  const [verified, setVerified] = useState<{ phone: string; offerPercent: number; offerReason: string | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const refreshSession = useCallback(async () => {
    try {
      const r = await api<{ phone: string | null; offerPercent: number; offerReason: string | null }>("/api/session/phone");
      setVerified(r.phone ? { phone: r.phone, offerPercent: r.offerPercent, offerReason: r.offerReason } : null);
      return r;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void refreshSession().then((r) => {
      if (r?.phone) setS((prev) => (prev.phone ? prev : { ...prev, phone: r.phone!.replace(/^\+91/, "") }));
    });
  }, [refreshSession]);
  const phoneVerified = !!verified && verified.phone === `+91${s.phone}`;

  // ── Availability ──
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSlots = useCallback(async (): Promise<Slot[] | null> => {
    if (!s.courtId || !s.date) return null;
    try {
      const r = await api<{ slots: Slot[] }>(`/api/availability?courtId=${encodeURIComponent(s.courtId)}&date=${s.date}`);
      setSlots(r.slots);
      setSlotsError(null);
      return r.slots;
    } catch (e) {
      setSlotsError((e as Error).message);
      return null;
    }
  }, [s.courtId, s.date]);

  useEffect(() => {
    if (!s.courtId || !s.date || locked) return;
    setSlots(null);
    void loadSlots();
    const t = setInterval(() => void loadSlots(), 30_000);
    return () => clearInterval(t);
  }, [s.courtId, s.date, locked, loadSlots]);

  useEffect(() => {
    if (!slots || s.times.length === 0 || locked) return;
    const ok = s.times.filter((t) => slots.find((x) => x.time === t)?.state === "AVAILABLE");
    if (ok.length !== s.times.length) {
      update({ times: [] });
      setNotice("Sorry — someone just booked that time. Please choose another time.");
    }
  }, [slots]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => (slots ?? []).filter((x) => s.times.includes(x.time)), [slots, s.times]);
  const offerPct = phoneVerified ? verified!.offerPercent : 0;
  const price = s.hold
    ? { subtotal: s.hold.subtotal, discount: s.hold.discount, total: s.hold.total, advance: s.hold.advance, balance: s.hold.balance }
    : priceBreakdown(selected.map((x) => x.price), settings, offerPct);
  const timeLabel = selected.length ? `${selected[0].label} – ${selected[selected.length - 1].endLabel}` : "";

  const runFrom = (i: number, hours = s.hours): Slot[] | null => {
    if (!slots) return null;
    const run = slots.slice(i, i + hours);
    return run.length === hours && run.every((x) => x.state === "AVAILABLE") ? run : null;
  };
  const startTime = s.times.length ? [...s.times].sort()[0] : null;

  const pickStart = (slot: Slot) => {
    if (!slots || locked) return;
    const run = runFrom(slots.indexOf(slot));
    if (!run) return;
    setNotice(null);
    const unselect = startTime === slot.time && s.times.length === s.hours;
    update({ times: unselect ? [] : run.map((x) => x.time) });
    if (!unselect) goTo(detailsRef, 350);
  };

  const setHours = (hours: number) => {
    if (locked) return;
    if (!startTime || !slots) return update({ hours });
    const run = runFrom(slots.findIndex((x) => x.time === startTime), hours);
    if (run) {
      setNotice(null);
      update({ hours, times: run.map((x) => x.time) });
    } else {
      update({ hours, times: [] });
      setNotice(`${hours} hours from ${slots.find((x) => x.time === startTime)?.label ?? "that time"} is not free. Please choose another start time.`);
    }
  };

  const visible = (slots ?? []).map((slot, i) => ({ slot, i })).filter(({ slot }) => slot.state !== "PAST");
  const anyFits = visible.some(({ i }) => !!runFrom(i));

  // ── Details ──
  const nameOk = s.name.replace(/\s+/g, " ").trim().length >= 2 && s.name.trim().length <= 50;
  const phoneOk = PHONE_RE.test(s.phone);
  const [touched, setTouched] = useState({ name: false, phone: false });

  // ── Hold + pay ──
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = selected.length > 0 && nameOk && phoneVerified && s.terms;

  const createHold = async () => {
    if (creating || !ready) return;
    setCreating(true);
    setError(null);
    try {
      const latest = await loadSlots();
      if (latest && !s.times.every((t) => latest.find((x) => x.time === t)?.state === "AVAILABLE")) {
        update({ times: [] });
        setNotice("Sorry — someone just booked that time. Please choose another time.");
        goTo(timeRef, 0);
        return;
      }
      const hold = await api<HoldResponse>("/api/bookings", {
        method: "POST",
        json: { courtId: s.courtId, date: s.date, times: s.times, name: s.name.replace(/\s+/g, " ").trim(), whatsappOptIn: s.optIn, acceptTerms: true, idempotencyKey: s.idempotencyKey },
      });
      if (hold.status === "CONFIRMED") {
        sessionStorage.removeItem(STORAGE_KEY);
        window.location.href = `/booking/${hold.bookingCode}?paid=1`;
        return;
      }
      // The server computes the price; if it differs from what this page showed (the owner changed a
      // price, or the offer no longer applies), say so and wait for the customer before paying. [SEC-61]
      const shown = { total: price.total, advance: price.advance };
      const changed = hold.total !== shown.total || hold.advance !== shown.advance;
      update({ hold, priceChange: changed ? shown : null });
      goTo(payRef, 0);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SLOT_TAKEN") {
        update({ times: [], idempotencyKey: newKey() });
        setNotice("Sorry — someone just booked that time. Please choose another time.");
        void loadSlots();
        goTo(timeRef, 0);
      } else if (e instanceof ApiError && e.code === "PHONE_NOT_VERIFIED") {
        setVerified(null);
        setError("Please verify your mobile number again.");
        goTo(detailsRef, 0);
      } else setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const startOver = () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setS((prev) => ({ ...fresh(), name: prev.name, phone: prev.phone, optIn: prev.optIn, sport: prev.sport, courtId: prev.courtId, date: prev.date, hours: prev.hours }));
    setError(null);
    goTo(timeRef, 0);
  };

  // The one big "what next" button at the bottom of the screen (mobile).
  const next: { label: string; action: () => void; primary?: boolean } = locked
    ? { label: "Go to payment", action: () => goTo(payRef, 0) }
    : !selected.length
      ? { label: "Choose a time", action: () => goTo(timeRef, 0) }
      : !nameOk || !phoneOk
        ? {
            label: "Enter your details",
            action: () => {
              goTo(detailsRef, 0);
              setTimeout(() => document.getElementById(nameOk ? "phone" : "name")?.focus({ preventScroll: true }), 450);
            },
          }
        : !phoneVerified
          ? {
              label: "Verify your mobile",
              action: () => {
                goTo(detailsRef, 0);
                setVerifying(true);
              },
            }
          : !s.terms
            ? { label: "Check & pay", action: () => goTo(payRef, 0) }
            : { label: `Pay ${inr(price.advance)}`, action: () => void createHold(), primary: true };

  const doneCount = [!!s.sport, !!s.date, selected.length > 0, nameOk && phoneVerified].filter(Boolean).length;
  const dateObj = dates.find((x) => x.key === s.date);
  const SportIcon = s.sport ? SPORT_ICON[s.sport] : CricketIcon;
  let stepNo = 0;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_390px]">
      <div className="min-w-0 overflow-hidden rounded-[28px] bg-white text-ink shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)]">
        {/* Progress */}
        <div className="h-1.5 bg-zinc-100" role="progressbar" aria-label="Booking progress" aria-valuemin={0} aria-valuemax={4} aria-valuenow={doneCount}>
          <div className="h-full bg-gradient-to-r from-pitch-600 to-flood-dim transition-[width] duration-700 ease-out" style={{ width: `${(doneCount / 4) * 100}%` }} />
        </div>

        <fieldset disabled={locked} className="min-w-0 px-5 pb-6 pt-5 sm:px-8">
          <legend className="sr-only">Booking details</legend>
          {locked && (
            <Alert tone="info" className="mb-4">
              Your slot is kept for you. Finish the payment below, or tap &quot;Start again&quot;.
            </Alert>
          )}

          <Step n={++stepNo} id="h-sport" title="What do you want to play?" icon={SportIcon} done={!!s.sport}>
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-labelledby="h-sport">
              {(["CRICKET", "PICKLEBALL"] as SportKey[]).map((sp) => {
                const cs = courtsFor(sp);
                const on = s.sport === sp;
                const Icon = SPORT_ICON[sp];
                return (
                  <button
                    key={sp}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={cs.length === 0}
                    onClick={() => {
                      update({ sport: sp, courtId: cs[0]?.id ?? null, times: [] });
                      goTo(dateRef);
                    }}
                    className={cn(
                      "tap group relative flex flex-col items-start gap-3 overflow-hidden rounded-3xl border-2 p-4 text-left transition duration-300 active:scale-[0.97] disabled:opacity-50",
                      on ? "border-ink bg-ink text-chalk shadow-[0_12px_30px_-12px_rgb(11_42_25/0.8)]" : "border-zinc-200 bg-white hover:border-pitch-600",
                    )}
                  >
                    <span className={cn("grid size-12 place-items-center rounded-2xl transition-colors", on ? "bg-flood text-flood-ink" : "bg-zinc-100 text-pitch-600")}>
                      <Icon className="size-7" />
                    </span>
                    <span>
                      <span className="block font-display text-[22px] font-extrabold uppercase leading-none">{siteConfig.sports[sp].label}</span>
                      <span className={cn("mt-1 block text-sm", on ? "text-flood" : "text-zinc-500")}>{fromPrices[sp] ? `from ${inr(fromPrices[sp]!)} / hour` : siteConfig.sports[sp].players}</span>
                    </span>
                    {on && <CheckIcon aria-hidden className="absolute right-3 top-3 size-5 animate-pop text-flood" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </Step>

          <Step n={++stepNo} id="h-date" title="Which day?" icon={CalendarIcon} done={!!s.date} innerRef={dateRef}>
            <ul className="no-scrollbar -mx-5 flex snap-x gap-2.5 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8">
              {dates.map((d) => {
                const on = s.date === d.key;
                return (
                  <li key={d.key} className="snap-start">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        update({ date: d.key, times: [] });
                        goTo(sportCourts.length > 1 ? courtRef : timeRef);
                      }}
                      className={cn(
                        "tap flex h-[84px] w-[76px] flex-col items-center justify-center rounded-2xl border-2 transition duration-300 active:scale-95",
                        on ? "border-ink bg-ink text-flood shadow-[0_10px_24px_-10px_rgb(11_42_25/0.9)]" : "border-zinc-200 hover:border-pitch-600",
                      )}
                    >
                      <span className="text-[11px] font-bold uppercase tracking-wide">{d.label}</span>
                      <span className="font-display text-[26px] font-bold leading-none">{d.sub.split(" ")[0]}</span>
                      <span className="text-[11px] font-semibold uppercase opacity-70">{d.sub.split(" ")[1]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Step>

          {sportCourts.length > 1 && (
            <Step n={++stepNo} id="h-court" title="Which court?" icon={CourtIcon} done={!!s.courtId} innerRef={courtRef}>
              <div className="grid grid-cols-2 gap-3">
                {sportCourts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={s.courtId === c.id}
                    onClick={() => {
                      update({ courtId: c.id, times: [] });
                      goTo(timeRef);
                    }}
                    className={cn(
                      "tap rounded-2xl border-2 px-4 py-4 text-left font-display text-lg font-bold uppercase transition duration-300 active:scale-[0.97]",
                      s.courtId === c.id ? "border-ink bg-ink text-flood" : "border-zinc-200 hover:border-pitch-600",
                    )}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </Step>
          )}

          <Step n={++stepNo} id="h-slots" title="What time?" icon={ClockIcon} done={selected.length > 0} innerRef={timeRef}>
            <p id="dur-label" className="mb-2 text-[15px] font-semibold">How many hours will you play?</p>
            <div role="radiogroup" aria-labelledby="dur-label" className="mb-5 grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={s.hours === h}
                  onClick={() => setHours(h)}
                  data-testid={`duration-${h}`}
                  className={cn(
                    "tap flex h-14 flex-col items-center justify-center rounded-2xl border-2 transition duration-300 active:scale-95",
                    s.hours === h ? "border-ink bg-ink text-flood" : "border-zinc-200 hover:border-pitch-600",
                  )}
                >
                  <span className="font-display text-2xl font-bold leading-none">{h}</span>
                  <span className="text-[11px] font-semibold uppercase">{h === 1 ? "hour" : "hours"}</span>
                </button>
              ))}
            </div>

            <p className="mb-3 text-[15px] font-semibold">Tap your start time</p>
            {notice && <Alert tone="warn" className="mb-3">{notice}</Alert>}
            {slotsError && (
              <Alert className="mb-3">
                {slotsError} <button type="button" className="underline" onClick={() => void loadSlots()}>Try again</button>
              </Alert>
            )}
            {!slots && !slotsError && <div className="grid grid-cols-3 gap-2">{Array.from({ length: 9 }, (_, i) => <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-zinc-100" />)}</div>}

            {slots && !anyFits && (
              <div className="rounded-2xl bg-zinc-50 p-5 text-center">
                <p className="font-semibold">No free time {s.hours > 1 ? `for ${s.hours} hours ` : ""}on this day.</p>
                <p className="mt-1 text-sm text-zinc-600">{s.hours > 1 ? "Try fewer hours or another day." : "Please choose another day."}</p>
                {(() => {
                  const idx = dates.findIndex((d) => d.key === s.date);
                  const nextDay = dates[idx + 1];
                  return nextDay ? (
                    <Button type="button" variant="dark" className="mt-4" onClick={() => update({ date: nextDay.key, times: [] })}>
                      See {nextDay.label === "Tomorrow" ? "tomorrow" : `${nextDay.label} ${nextDay.sub}`}
                    </Button>
                  ) : null;
                })()}
              </div>
            )}

            {slots && anyFits && (
              <div className="space-y-5">
                {PERIODS.map(({ key, label, Icon, test }) => {
                  const group = visible.filter(({ slot }) => test(Number(slot.time.slice(0, 2))));
                  if (!group.length) return null;
                  return (
                    <div key={key}>
                      <p className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-500">
                        <Icon className="size-4" /> {label}
                      </p>
                      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={`${label} times`}>
                        {group.map(({ slot, i }) => {
                          const isStart = slot.time === startTime;
                          const inRange = !isStart && s.times.includes(slot.time);
                          const run = runFrom(i);
                          const fits = !!run;
                          const avail = slot.state === "AVAILABLE";
                          const runPrice = run ? run.reduce((a, b) => a + b.price, 0) : slot.price;
                          return (
                            <li key={slot.time}>
                              <button
                                type="button"
                                onClick={() => pickStart(slot)}
                                disabled={!fits && !isStart}
                                aria-pressed={fits ? isStart : undefined}
                                aria-label={fits ? `Start at ${slot.label}, play ${s.hours} hour${s.hours > 1 ? "s" : ""} until ${run![run!.length - 1].endLabel}, ${inr(runPrice)}` : undefined}
                                data-state={slot.state}
                                data-fits={fits}
                                data-time={slot.time}
                                className={cn(
                                  "tap flex min-h-[68px] w-full flex-col items-center justify-center rounded-2xl border-2 px-1 py-2 text-center leading-tight transition duration-200 active:scale-95",
                                  isStart && "animate-pop border-ink bg-ink text-flood shadow-[0_10px_24px_-10px_rgb(11_42_25/0.9)]",
                                  inRange && "border-ink bg-pitch-700 text-flood",
                                  !isStart && !inRange && fits && "border-zinc-200 bg-white hover:border-pitch-600",
                                  !isStart && !inRange && !fits && "border-transparent bg-zinc-100 text-zinc-400",
                                )}
                              >
                                <span className="text-[17px] font-bold tabular-nums">{slot.label}</span>
                                <span className="mt-0.5 text-xs font-medium">
                                  {inRange
                                    ? "included"
                                    : fits || isStart
                                      ? s.hours > 1
                                        ? `to ${(run ?? selected)[(run ?? selected).length - 1]?.endLabel} · ${inr(isStart ? selected.reduce((a, b) => a + b.price, 0) : runPrice)}`
                                        : inr(slot.price)
                                      : avail
                                        ? "not enough time"
                                        : slot.state === "BOOKED"
                                          ? "booked"
                                          : "closed"}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </Step>

          <Step n={++stepNo} id="h-details" title="Your details" icon={UserIcon} done={nameOk && phoneVerified} innerRef={detailsRef}>
            <div className="space-y-5">
              <div>
                <label htmlFor="name" className="mb-1.5 flex items-center gap-2 text-[15px] font-semibold">
                  <UserIcon className="size-4 text-zinc-400" /> Your name
                </label>
                <Input
                  id="name"
                  autoComplete="name"
                  placeholder="e.g. Ravi Kumar"
                  value={s.name}
                  maxLength={50}
                  onChange={(e) => update({ name: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  aria-invalid={touched.name && !nameOk}
                  aria-describedby={touched.name && !nameOk ? "name-err" : undefined}
                  className="h-14 text-lg"
                />
                {touched.name && !nameOk && (
                  <p id="name-err" role="alert" className="mt-1.5 text-sm font-medium text-[#c2331a]">Please write your name.</p>
                )}
              </div>

              <div>
                <label htmlFor="phone" className="mb-1.5 flex items-center gap-2 text-[15px] font-semibold">
                  <PhoneIcon className="size-4 text-zinc-400" /> Your mobile number
                </label>
                <div className="flex">
                  <span className="grid h-14 place-items-center rounded-l-xl border border-r-0 border-zinc-300 bg-zinc-50 px-3 text-lg font-semibold text-zinc-600">+91</span>
                  <Input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder="10 digit number"
                    className="h-14 rounded-l-none text-lg tracking-wider"
                    value={s.phone}
                    maxLength={10}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(0, 10);
                      update({ phone: v });
                      setVerifying(false);
                    }}
                    onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                    aria-invalid={touched.phone && !phoneOk}
                    aria-describedby="phone-hint"
                  />
                </div>
                <p id="phone-hint" className="mt-1.5 text-sm text-zinc-500">
                  {touched.phone && !phoneOk && s.phone.length > 0 ? (
                    <span className="font-medium text-[#c2331a]">Please check the number — it should have 10 digits.</span>
                  ) : phoneVerified ? (
                    ""
                  ) : (
                    "We will send a 6-digit code to this number."
                  )}
                </p>

                {phoneVerified ? (
                  <p className="mt-2 flex animate-[fadein_.3s_ease_both] items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 font-bold text-emerald-800" data-testid="phone-verified">
                    <CheckIcon className="size-5" strokeWidth={3} /> Mobile number verified
                  </p>
                ) : verifying ? (
                  <div className="mt-3 animate-[fadein_.3s_ease_both] rounded-2xl border-2 border-zinc-200 p-4">
                    <OtpVerify
                      key={s.phone}
                      target={{ phone: `+91${s.phone}` }}
                      onVerified={async () => {
                        await refreshSession();
                        setVerifying(false);
                        goTo(payRef, 300);
                      }}
                      onChangeNumber={() => {
                        setVerifying(false);
                        document.getElementById("phone")?.focus();
                      }}
                    />
                  </div>
                ) : (
                  <Button type="button" variant="dark" size="lg" className="mt-3 h-14 w-full text-base" disabled={!phoneOk} onClick={() => setVerifying(true)} data-testid="verify-phone">
                    Send code to my mobile
                  </Button>
                )}

                {phoneVerified && settings.offerPercent > 0 && verified!.offerPercent === 0 && (verified!.offerReason === "DEVICE_USED" || verified!.offerReason === "RETURNING_NUMBER") && (
                  <p className="mt-2 rounded-2xl bg-zinc-100 px-4 py-3 text-sm text-zinc-700" data-testid="offer-not-eligible">
                    {verified!.offerReason === "DEVICE_USED"
                      ? "The new-customer offer has already been used on this phone. It's one offer per phone and per number."
                      : "Welcome back! The new-customer offer is only for a first booking."}
                  </p>
                )}
                {phoneVerified && verified!.offerPercent > 0 && (
                  <p className="mt-2 flex animate-[fadein_.4s_ease_both] items-center gap-2 rounded-2xl bg-gradient-to-r from-flood/40 to-flood/10 px-4 py-3 font-semibold" data-testid="offer-applied">
                    <GiftIcon className="size-5 shrink-0" /> Welcome! You get {verified!.offerPercent}% off this booking.
                  </p>
                )}
              </div>

              <label className="tap flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-zinc-200 p-4">
                <input type="checkbox" className="size-6 shrink-0 accent-pitch-600" checked={s.optIn} onChange={(e) => update({ optIn: e.target.checked })} />
                <span className="text-[15px]">
                  <strong>Send my booking details on WhatsApp</strong>
                  <span className="block text-sm text-zinc-500">Confirmation and a reminder before you play.</span>
                </span>
              </label>
            </div>
          </Step>
        </fieldset>
      </div>

      {/* Check & pay */}
      <aside ref={payRef} aria-labelledby="h-summary" className="scroll-mt-24 overflow-hidden rounded-[28px] bg-white text-ink shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] lg:sticky lg:top-24">
        <div className="bg-ink px-5 py-4 text-chalk sm:px-6">
          <h2 id="h-summary" className="font-display text-[26px] font-extrabold uppercase leading-none">
            Check &amp; <span className="text-flood">pay</span>
          </h2>
        </div>
        <div className="p-5 sm:p-6">
          {settings.offerPercent > 0 && !phoneVerified && !s.hold && (
            <p className="mb-4 flex items-start gap-2 rounded-2xl border-2 border-dashed border-flood-dim bg-flood/15 px-3 py-2.5 text-sm">
              <GiftIcon className="mt-0.5 size-5 shrink-0" />
              <span>
                <strong>New here? Get {settings.offerPercent}% off</strong> your first booking. Verify your mobile to get it.
              </span>
            </p>
          )}
          <dl className="space-y-2.5 text-[15px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-zinc-500"><SportIcon className="size-4" /> {s.sport ? siteConfig.sports[s.sport].label : "Game"}</dt>
              <dd className="text-right font-semibold">{court?.name ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-zinc-500"><CalendarIcon className="size-4" /> Day</dt>
              <dd className="text-right font-semibold">{dateObj ? `${dateObj.label}, ${dateObj.sub}` : "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-zinc-500"><ClockIcon className="size-4" /> Time</dt>
              <dd className="text-right font-semibold">{timeLabel ? `${timeLabel} (${selected.length} hr)` : <span className="text-zinc-400">Choose a time</span>}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-zinc-100 pt-2.5">
              <dt className="text-zinc-500">Price</dt>
              <dd className="font-semibold tabular-nums"><AnimatedNumber value={price.subtotal} format={inr} /></dd>
            </div>
            {price.discount > 0 && (
              <div className="flex animate-[fadein_.4s_ease_both] justify-between gap-3 text-emerald-700" data-testid="discount-line">
                <dt className="flex items-center gap-1.5 font-semibold"><GiftIcon className="size-4" /> New customer offer</dt>
                <dd className="font-bold tabular-nums">−<AnimatedNumber value={price.discount} format={inr} /></dd>
              </div>
            )}
            <div className="flex items-end justify-between gap-3">
              <dt className="font-semibold">Total</dt>
              <dd className="font-display text-3xl font-bold leading-none tabular-nums" data-testid="live-total"><AnimatedNumber value={price.total} format={inr} /></dd>
            </div>
          </dl>
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-2xl bg-flood/30 px-3 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-pitch-700">Pay now</p>
              <p className="font-display text-2xl font-bold tabular-nums"><AnimatedNumber value={price.advance} format={inr} /></p>
            </div>
            <div className="rounded-2xl bg-zinc-100 px-3 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">At the ground</p>
              <p className="font-display text-2xl font-bold tabular-nums"><AnimatedNumber value={price.balance} format={inr} /></p>
            </div>
          </div>

          {!s.hold ? (
            <>
              <div className="mt-4 rounded-2xl bg-zinc-50 p-4 text-sm text-zinc-700">
                <p className="flex items-center gap-2 font-bold text-ink"><ShieldIcon className="size-4 text-pitch-600" /> Cancellation</p>
                <p className="mt-1" data-testid="form-policy">{settings.policy}</p>
              </div>
              <label className="tap mt-3 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-zinc-200 p-4">
                <input type="checkbox" className="size-6 shrink-0 accent-pitch-600" checked={s.terms} onChange={(e) => update({ terms: e.target.checked })} data-testid="terms" />
                <span className="text-[15px]">
                  I agree to the <Link href="/refund-policy" target="_blank" className="font-semibold underline">rules</Link> and{" "}
                  <Link href="/terms" target="_blank" className="font-semibold underline">terms</Link>
                </span>
              </label>
              {error && <Alert className="mt-3">{error}</Alert>}
              <Button size="lg" className={cn("mt-4 h-16 w-full text-lg", ready && "shine")} disabled={!ready} loading={creating} onClick={createHold} data-testid="hold-button">
                {creating ? "Keeping your slot…" : `Pay ${inr(price.advance)} & confirm`}
              </Button>
              {!ready && (
                <p className="mt-2 text-center text-sm text-zinc-500" aria-live="polite">
                  {!selected.length ? "First choose a time." : !nameOk ? "Write your name." : !phoneVerified ? "Verify your mobile number." : "Tick “I agree” to continue."}
                </p>
              )}
            </>
          ) : (
            <div className="mt-4 animate-[fadein_.3s_ease_both]">
              <p className="mb-3 text-sm text-zinc-600">
                Booking <strong className="font-mono" data-testid="hold-code">{s.hold.bookingCode}</strong>
              </p>
              {s.priceChange && (
                <div data-testid="price-updated">
                <Alert tone="warn" className="mb-3">
                  <strong>Price updated.</strong> This slot now costs {inr(s.hold.total)} (we showed {inr(s.priceChange.total)}). Pay{" "}
                  {inr(s.hold.advance)} now{s.hold.balance > 0 ? `, ${inr(s.hold.balance)} at the venue` : ""} — or press &ldquo;Start again&rdquo;.
                </Alert>
                </div>
              )}
              <PaymentPanel hold={s.hold} autoStart={!s.priceChange} />
              <button type="button" onClick={startOver} className="mt-4 w-full py-2 text-center text-sm font-semibold text-zinc-500 underline">
                Start again
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile: one big "what next" button */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 text-ink shadow-[0_-10px_30px_rgb(0_0_0/0.15)] backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-[26px] font-bold leading-none tabular-nums">
              {selected.length ? <AnimatedNumber value={price.total} format={inr} /> : <span className="text-zinc-400">—</span>}
            </p>
            <p className="truncate text-xs text-zinc-600">{selected.length ? `${timeLabel}${price.discount > 0 ? ` · ${offerPct}% off` : ""}` : "Choose a time to see the price"}</p>
          </div>
          <Button variant={next.primary ? "flood" : "dark"} className={cn("h-14 shrink-0 px-6 text-base", next.primary && "shine")} onClick={next.action} loading={next.primary && creating} data-testid="next-action">
            {next.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
