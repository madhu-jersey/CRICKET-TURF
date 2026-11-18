"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";

export function AccountForms({ email }: { email: string }) {
  const router = useRouter();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [phonePw, setPhonePw] = useState("");
  const [phoneMsg, setPhoneMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            await adminApi("/api/admin/password", { method: "PUT", json: { currentPassword: cur, newPassword: next } });
            setMsg({ tone: "success", text: "Password changed. Other devices were signed out." });
            setCur("");
            setNext("");
            router.refresh();
          } catch (err) {
            setMsg({ tone: "error", text: (err as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Change password</h2>
        <input type="hidden" autoComplete="username" value={email} readOnly />
        <div>
          <Label htmlFor="a-cur">Current password</Label>
          <Input id="a-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="a-new">New password (at least 10 characters, not your email)</Label>
          <Input id="a-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} className="h-10" />
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button type="submit" variant="dark" loading={busy} data-testid="change-password">Change password</Button>
      </form>

      <form
        className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setPhoneMsg(null);
          try {
            await adminApi("/api/admin/account/phone", { method: "PUT", json: { phone, currentPassword: phonePw } });
            setPhoneMsg({ tone: "success", text: "Phone updated. Login codes now go to this number." });
            setPhonePw("");
            router.refresh();
          } catch (err) {
            setPhoneMsg({ tone: "error", text: (err as Error).message });
          }
        }}
      >
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Phone for login codes</h2>
        <div>
          <Label htmlFor="a-phone">Mobile (10 digits)</Label>
          <Input id="a-phone" type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="a-phone-pw">Current password</Label>
          <Input id="a-phone-pw" type="password" autoComplete="current-password" value={phonePw} onChange={(e) => setPhonePw(e.target.value)} required className="h-10" />
        </div>
        {phoneMsg && <Alert tone={phoneMsg.tone}>{phoneMsg.text}</Alert>}
        <Button type="submit" variant="light">Save phone</Button>
      </form>
    </div>
  );
}
