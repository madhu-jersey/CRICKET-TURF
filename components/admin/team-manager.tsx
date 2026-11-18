"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";

type U = { id: string; email: string; name: string; role: string; isActive: boolean; phone: string | null; mustChangePassword: boolean };

export function TeamManager({ users }: { users: U[] }) {
  const router = useRouter();
  const [f, setF] = useState({ email: "", name: "", phone: "", tempPassword: "" });
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (id: string, action: Record<string, unknown>, ok: string) => {
    setMsg(null);
    try {
      await adminApi("/api/admin/users", { method: "PATCH", json: { id, action } });
      setMsg({ tone: "success", text: ok });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="font-semibold">
                {u.name} <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold">{u.role.toLowerCase()}</span>
                {!u.isActive && <span className="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">disabled</span>}
                {u.mustChangePassword && <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">must change password</span>}
              </p>
              <p className="text-zinc-500">{u.email} · {u.phone ?? "no phone"}</p>
            </div>
            {u.role === "STAFF" && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="light"
                  size="sm"
                  onClick={() => {
                    const pw = window.prompt("Temporary password for this staff member (10+ characters). They must change it at next login.");
                    if (pw) void act(u.id, { type: "reset_password", tempPassword: pw }, "Password reset. They must choose a new one at next login.");
                  }}
                >
                  Reset password
                </Button>
                {u.isActive ? (
                  <Button variant="light" size="sm" onClick={() => window.confirm(`Disable ${u.email}?`) && act(u.id, { type: "disable" }, "Account disabled and signed out.")}>Disable</Button>
                ) : (
                  <Button variant="light" size="sm" onClick={() => act(u.id, { type: "enable" }, "Account enabled.")}>Enable</Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <form
        className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-5 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            await adminApi("/api/admin/users", { method: "POST", json: f });
            setMsg({ tone: "success", text: `Staff account created for ${f.email}. Share the temporary password in person.` });
            setF({ email: "", name: "", phone: "", tempPassword: "" });
            router.refresh();
          } catch (err) {
            setMsg({ tone: "error", text: (err as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-500 sm:col-span-2">Add staff</h2>
        <div>
          <Label htmlFor="t-name">Name</Label>
          <Input id="t-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="t-email">Email</Label>
          <Input id="t-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="t-phone">Mobile (10 digits, for login codes)</Label>
          <Input id="t-phone" type="tel" inputMode="numeric" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="t-pw">Temporary password (10+ characters)</Label>
          <Input id="t-pw" type="text" autoComplete="off" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} required minLength={10} className="h-10" />
        </div>
        <Button type="submit" variant="dark" loading={busy} className="sm:col-span-2">Add staff member</Button>
      </form>
    </div>
  );
}
