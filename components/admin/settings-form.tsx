"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";

type S = Record<"advanceType" | "advanceValue" | "holdMinutes" | "cancellationCutoffHours" | "refundPercentBeforeCutoff" | "maxDaysAhead" | "newCustomerDiscountPercent" | "ownerAlertPhone" | "businessName" | "address" | "mapLink" | "phone", string>;

export function SettingsForm({ initial, providers }: { initial: S; providers: { payment: string; messaging: string; otp: string; demo: boolean } }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const f = (k: keyof S) => ({ id: `s-${k}`, value: s[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setS({ ...s, [k]: e.target.value }) });

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
          <Select {...f("advanceType")} className="h-10 text-sm">
            <option value="FIXED">Fixed amount (₹)</option>
            <option value="PERCENT">Percent of total</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="s-advanceValue">{s.advanceType === "FIXED" ? "Advance (₹)" : "Advance (%)"}</Label>
          <Input type="number" min={0} {...f("advanceValue")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-holdMinutes">Slot hold (minutes)</Label>
          <Input type="number" min={2} max={60} {...f("holdMinutes")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-maxDaysAhead">Book up to (days ahead)</Label>
          <Input type="number" min={1} max={90} {...f("maxDaysAhead")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-cancellationCutoffHours">Free cancellation until (hours before)</Label>
          <Input type="number" min={0} max={168} {...f("cancellationCutoffHours")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-refundPercentBeforeCutoff">Refund % before cutoff</Label>
          <Input type="number" min={0} max={100} {...f("refundPercentBeforeCutoff")} className="h-10" />
        </div>
        <div className="col-span-2">
          <Label htmlFor="s-newCustomerDiscountPercent">New customer offer — % off first booking (0 = off)</Label>
          <Input type="number" min={0} max={50} {...f("newCustomerDiscountPercent")} className="h-10" />
          <p className="mt-1 text-xs text-zinc-500">Applies to a mobile number&apos;s first online booking. Checked on the server after OTP verification.</p>
        </div>
        <div className="col-span-2">
          <Label htmlFor="s-ownerAlertPhone">Owner alert WhatsApp number (10 digits, blank to disable)</Label>
          <Input type="tel" inputMode="numeric" {...f("ownerAlertPhone")} className="h-10" />
        </div>
      </fieldset>
      <fieldset className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-bold uppercase tracking-wider text-zinc-500">Business info</legend>
        <div>
          <Label htmlFor="s-businessName">Business name</Label>
          <Input {...f("businessName")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-address">Address</Label>
          <Input {...f("address")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-mapLink">Google Maps link</Label>
          <Input type="url" {...f("mapLink")} className="h-10" />
        </div>
        <div>
          <Label htmlFor="s-phone">Contact phone (10 digits)</Label>
          <Input type="tel" inputMode="numeric" {...f("phone")} className="h-10" />
        </div>
        <div className="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600">
          Providers (set by environment variables): payments <strong>{providers.payment}</strong> · WhatsApp <strong>{providers.messaging}</strong> · OTP <strong>{providers.otp}</strong> · demo mode <strong>{providers.demo ? "on" : "off"}</strong>
        </div>
      </fieldset>
      <div className="xl:col-span-2">
        {error && <Alert className="mb-3">{error}</Alert>}
        {ok && <Alert tone="success" className="mb-3">Settings saved.</Alert>}
        <Button type="submit" variant="dark" loading={busy}>Save settings</Button>
      </div>
    </form>
  );
}
