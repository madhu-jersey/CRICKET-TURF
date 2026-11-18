"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";
import { api } from "@/lib/utils";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm">
        <Alert tone="success">Password changed. All devices were signed out.</Alert>
        <Link href="/admin/login" className="block text-center font-semibold underline">Sign in</Link>
      </div>
    );
  }

  return (
    <form
      className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (!sent) {
            const r = await api<{ message: string }>("/api/admin/password", { method: "POST", json: { email } });
            setSent(r.message);
          } else {
            await api("/api/admin/password", { method: "PATCH", json: { email, code, newPassword: pw } });
            setDone(true);
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <Label htmlFor="f-email">Email</Label>
        <Input id="f-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={!!sent} />
      </div>
      {sent && (
        <>
          <Alert tone="info">{sent}</Alert>
          <div>
            <Label htmlFor="f-code">6-digit code</Label>
            <Input id="f-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required />
          </div>
          <div>
            <Label htmlFor="f-pw">New password (at least 10 characters)</Label>
            <Input id="f-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} />
          </div>
        </>
      )}
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="dark" size="lg" className="w-full" loading={busy}>
        {sent ? "Set new password" : "Send code"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/admin/login" className="underline">Back to sign in</Link>
      </p>
    </form>
  );
}
