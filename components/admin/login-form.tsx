"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";
import { api } from "@/lib/utils";

type LoginRes = { role?: string; mustChangePassword?: boolean; twoFactor?: boolean; challengeId?: string; maskedPhone?: string; devCode?: string };

export function LoginForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [trust, setTrust] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; maskedPhone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (r: LoginRes) => {
    window.location.href = r.mustChangePassword ? "/admin/account?force=1" : r.role === "OWNER" ? "/admin" : "/admin/bookings";
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!challenge) {
        const r = await api<LoginRes>("/api/admin/login", { method: "POST", json: { email, password, trustDevice: trust } });
        if (r.twoFactor && r.challengeId) {
          setChallenge({ id: r.challengeId, maskedPhone: r.maskedPhone ?? "", devCode: r.devCode });
          setBusy(false);
          return;
        }
        done(r);
      } else {
        done(await api<LoginRes>("/api/admin/login/verify", { method: "POST", json: { challengeId: challenge.id, code } }));
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm">
      {demo && !challenge && (
        <Alert tone="info">
          Demo logins: <strong>owner@demo.com</strong> or <strong>staff@demo.com</strong>, password <strong>Demo@1234</strong>
        </Alert>
      )}
      {!challenge ? (
        <>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            Trust this device for 30 days (skip the code next time)
          </label>
        </>
      ) : (
        <div>
          <p className="text-sm text-zinc-600">
            We sent a 6-digit code to <strong>{challenge.maskedPhone}</strong>.
          </p>
          {challenge.devCode && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm" data-testid="admin-dev-code">
              Demo code: <strong className="font-mono">{challenge.devCode}</strong>
            </p>
          )}
          <Label htmlFor="code" className="mt-3">Login code</Label>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required autoFocus />
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="dark" size="lg" className="w-full" loading={busy}>
        {challenge ? "Verify code" : "Sign in"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/admin/forgot" className="font-semibold underline">Forgot password?</Link>
      </p>
    </form>
  );
}
