"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";
import { SETTINGS_FIELDS } from "@/lib/admin/settings-fields";

type S = Record<(typeof SETTINGS_FIELDS)[number], string>;

function Num({ f, id, label, min, max, hint }: { f: (k: keyof S) => object; id: keyof S; label: string; min: number; max: number; hint?: string }) {
  return (
    <div>
      <Label htmlFor={`s-${id}`}>{label}</Label>
      <Input type="number" min={min} max={max} {...f(id)} className="h-10 min-h-11 md:min-h-0" />
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

export function SettingsForm({
  initial,
  providers,
  otpToday,
}: {
  initial: S;
  providers: { payment: string; messaging: string; otp: string; demo: boolean };
  otpToday: { new: { used: number; cap: number }; returning: { used: number; cap: number } };
}) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [boost, setBoost] = useState("100");
  const [boostMsg, setBoostMsg] = useState<string | null>(null);
  const f = (k: keyof S) => ({ id: `s-${k}`, value: s[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setS({ ...s, [k]: e.target.value }) });

  const raiseCap = async () => {
    setBoostMsg(null);
    try {
      const r = await adminApi<{ boost: number }>("/api/admin/otp-cap", { method: "POST", json: { amount: Number(boost) } });
      setBoostMsg(`Today's limits are now raised by ${r.boost} in total.`);
      router.refresh();
    } catch (e) {
      setBoostMsg((e as Error).message);
    }
  };

  return (
    <form
      className="grid gap-4 xl:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setOk(false);
        try {
          await adminApi("/api/admin/settings", { method: "PUT", json: s });
          setOk(true);
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-bold uppercase tracking-wider text-zinc-500">Booking rules</legend>
        <div>
          <Label htmlFor="s-advanceType">Advance type</Label>
          <Select {...f("advanceType")} className="h-10 min-h-11 md:min-h-0 text-sm">
            <option value="FIXED">Fixed amount (₹)</option>
            <option value="PERCENT">Percent of total</option>
          </Select>
        </div>
        <Num f={f} id="advanceValue" label={s.advanceType === "FIXED" ? "Advance (₹)" : "Advance (%)"} min={0} max={100000} />
        <Num f={f} id="holdMinutes" label="Slot hold (minutes)" min={2} max={60} />
        <Num f={f} id="maxDaysAhead" label="Book up to (days ahead)" min={1} max={90} />
        <Num f={f} id="newCustomerDiscountPercent" label="New customer offer (% off, 0 = off)" min={0} max={50} />
        <div className="col-span-2">
          <Label htmlFor="s-ownerAlertPhone">Owner alert WhatsApp number (10 digits, blank to disable)</Label>
          <Input type="tel" inputMode="numeric" {...f("ownerAlertPhone")} className="h-10 min-h-11 md:min-h-0" />
        </div>
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-bold uppercase tracking-wider text-zinc-500">Cancellation &amp; refunds</legend>
        <Num f={f} id="cancelCutoffHours" label="Online cancelling closes (hours before start)" min={0} max={168} hint="0 = customers can cancel online until the slot starts." />
        <Num f={f} id="refundCutoffHours" label="Refund cutoff (hours before start)" min={0} max={168} />
        <Num f={f} id="refundPercentBeforeCutoff" label="Refund % if cancelled before the cutoff" min={0} max={100} />
        <Num f={f} id="refundPercentAfterCutoff" label="Refund % if cancelled after the cutoff" min={0} max={100} />
        <p className="col-span-2 text-xs text-zinc-500">These numbers drive the refund-policy page, the booking page, the booking status page and the WhatsApp messages — nothing else to update.</p>
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-bold uppercase tracking-wider text-zinc-500">Spam protection</legend>
        <Num f={f} id="maxActiveBookingsPerPhone" label="Max upcoming bookings per number" min={1} max={20} />
        <Num f={f} id="maxBookingsPerPhonePerDay" label="Max new bookings per number per day" min={1} max={50} />
        <Num f={f} id="noShowBlockThreshold" label="Block after this many no-shows (0 = never)" min={0} max={20} />
        <Num f={f} id="autoCompleteHours" label="Mark played automatically this many hours after the slot ends (0 = off)" min={0} max={72} hint="Staff can still change a booking to no-show afterwards." />
        <div />
        <Num f={f} id="otpDailyCapNew" label="Daily OTP limit — new numbers" min={10} max={100000} hint={`Today: ${otpToday.new.used} / ${otpToday.new.cap}`} />
        <Num f={f} id="otpDailyCapReturning" label="Daily OTP limit — returning customers" min={10} max={100000} hint={`Today: ${otpToday.returning.used} / ${otpToday.returning.cap}`} />
        <div className="col-span-2 flex flex-wrap items-end gap-2 rounded-xl bg-zinc-50 p-3">
          <div>
            <Label htmlFor="boost">Raise today&apos;s OTP limits by</Label>
            <Input id="boost" type="number" min={1} max={10000} value={boost} onChange={(e) => setBoost(e.target.value)} className="h-10 w-28" />
          </div>
          <Button type="button" variant="dark" size="sm" className="h-10 min-h-11 md:min-h-0" onClick={raiseCap} data-testid="raise-cap">Raise today&apos;s limits</Button>
          {boostMsg && <p className="w-full text-xs text-zinc-600" role="status">{boostMsg}</p>}
        </div>
        <p className="col-span-2 text-xs font-semibold text-zinc-600">Per network (mobile carriers share IPs — keep these loose):</p>
        <Num f={f} id="otpSendPerIpHour" label="Codes sent per network per hour" min={1} max={10000} />
        <Num f={f} id="otpVerifyPerIpHour" label="Code checks per network per hour" min={1} max={10000} />
        <Num f={f} id="bookingPerIpHour" label="Booking attempts per network per hour" min={1} max={10000} />
        <Num f={f} id="cancelPerIpHour" label="Cancels per network per hour" min={1} max={10000} />
      </fieldset>

      <fieldset className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-bold uppercase tracking-wider text-zinc-500">Business info</legend>
        <div>
          <Label htmlFor="s-businessName">Business name</Label>
          <Input {...f("businessName")} className="h-10 min-h-11 md:min-h-0" />
        </div>
        <div>
          <Label htmlFor="s-address">Address</Label>
          <Input {...f("address")} className="h-10 min-h-11 md:min-h-0" />
        </div>
        <div>
          <Label htmlFor="s-mapLink">Google Maps link</Label>
          <Input type="url" {...f("mapLink")} className="h-10 min-h-11 md:min-h-0" />
        </div>
        <div>
          <Label htmlFor="s-phone">Contact phone (10 digits)</Label>
          <Input type="tel" inputMode="numeric" {...f("phone")} className="h-10 min-h-11 md:min-h-0" />
        </div>
        <div className="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600">
          Providers (set by environment variables): payments <strong>{providers.payment}</strong> · WhatsApp <strong>{providers.messaging}</strong> · OTP <strong>{providers.otp}</strong> · demo mode <strong>{providers.demo ? "on" : "off"}</strong>
        </div>
      </fieldset>
      <div className="xl:col-span-2">
        {error && <Alert className="mb-3">{error}</Alert>}
        {ok && <Alert tone="success" className="mb-3">Settings saved.</Alert>}
        <Button type="submit" variant="dark" loading={busy} data-testid="save-settings">Save settings</Button>
      </div>
    </form>
  );
}
