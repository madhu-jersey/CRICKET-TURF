"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";
import { api } from "@/lib/utils";
import { RecoveryCodesPanel } from "@/components/admin/recovery-codes";

type LoginRes = { role?: string; mustChangePassword?: boolean; twoFactor?: boolean; challengeId?: string; maskedPhone?: string; devCode?: string; recoveryCodes?: string[] };

export function LoginForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [trust, setTrust] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; maskedPhone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recovery, setRecovery] = useState("");
  const [newCodes, setNewCodes] = useState<{ codes: string[]; res: LoginRes } | null>(null);
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
        const r = await api<LoginRes>("/api/admin/login/verify", {
          method: "POST",
          json: useRecovery ? { challengeId: challenge.id, recoveryCode: recovery } : { challengeId: challenge.id, code },
        });
        // First two-step login: show the new recovery codes once before going in. [SEC-41]
        if (r.recoveryCodes?.length) {
          setNewCodes({ codes: r.recoveryCodes, res: r });
          setBusy(false);
          return;
        }
        done(r);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (newCodes) {
    return (
      <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-lg font-bold">Your recovery codes</h2>
        <RecoveryCodesPanel codes={newCodes.codes} onDone={() => done(newCodes.res)} doneLabel="Continue to dashboard" />
      </div>
    );
  }

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
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="h-5 w-5" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            Trust this device for 30 days (skip the code next time)
          </label>
        </>
      ) : (
        <div>
          <p className="text-sm text-zinc-600">
            We sent a 6-digit code to <strong>{challenge.maskedPhone}</strong>.
          </p>
          {challenge.devCode && !useRecovery && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm" data-testid="admin-dev-code">
              Demo code: <strong className="font-mono">{challenge.devCode}</strong>
            </p>
          )}
          {!useRecovery ? (
            <>
              <Label htmlFor="code" className="mt-3">Login code</Label>
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required autoFocus />
            </>
          ) : (
            <>
              <Label htmlFor="recovery" className="mt-3">Recovery code</Label>
              <Input id="recovery" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCDE-FGHJK" maxLength={20} value={recovery} onChange={(e) => setRecovery(e.target.value.toUpperCase())} required autoFocus />
              <p className="mt-1 text-xs text-zinc-500">Each recovery code works once. The owner is told when one is used.</p>
            </>
          )}
          <button
            type="button"
            className="mt-2 min-h-11 text-sm font-semibold underline"
            onClick={() => {
              setUseRecovery((v) => !v);
              setError(null);
            }}
          >
            {useRecovery ? "Use the code from my phone" : "Lost your phone? Use a recovery code"}
          </button>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="dark" size="lg" className="w-full" loading={busy}>
        {challenge ? (useRecovery ? "Use recovery code" : "Verify code") : "Sign in"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/admin/forgot" className="inline-flex min-h-11 items-center font-semibold underline">Forgot password?</Link>
      </p>
    </form>
  );
}
