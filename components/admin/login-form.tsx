"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";
import { api } from "@/lib/utils";

export function LoginForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ role: string }>("/api/admin/login", { method: "POST", json: { email, password } });
      window.location.href = r.role === "OWNER" ? "/admin" : "/admin/bookings";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm">
      {demo && (
        <Alert tone="info">
          Demo logins: <strong>owner@demo.com</strong> or <strong>staff@demo.com</strong>, password <strong>Demo@1234</strong>
        </Alert>
      )}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="dark" size="lg" className="w-full" loading={busy}>
        Sign in
      </Button>
    </form>
  );
}
