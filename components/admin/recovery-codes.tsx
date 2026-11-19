"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/field";
import { adminApi } from "@/lib/admin/client";

/** Shows a fresh set of recovery codes once, with copy / download, and a "saved them" confirmation. [SEC-41] */
export function RecoveryCodesPanel({ codes, onDone, doneLabel = "I've saved them" }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = `Boundary Box Arena — admin recovery codes\nEach code works once. Keep them somewhere safe (not on this phone).\n\n${codes.join("\n")}\n`;

  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <Alert tone="warn">
        Save these 10 recovery codes now. If you lose your phone, each one lets you sign in once instead of the phone code.
        <strong> They won&apos;t be shown again.</strong>
      </Alert>
      <ol className="grid grid-cols-2 gap-2 rounded-xl bg-zinc-50 p-3 font-mono text-sm sm:text-base">
        {codes.map((c) => (
          <li key={c} className="rounded-lg bg-white px-2 py-2 text-center tracking-wider shadow-sm" data-testid="recovery-code">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="light"
          className="min-h-11 flex-1"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button
          type="button"
          variant="light"
          className="min-h-11 flex-1"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "bba-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="recovery-saved" />
        I&apos;ve saved these codes somewhere safe
      </label>
      <Button type="button" variant="dark" size="lg" className="w-full" disabled={!saved} onClick={onDone} data-testid="recovery-continue">
        {doneLabel}
      </Button>
    </div>
  );
}

/** /admin/account section: how many codes are left, and "make new codes" (needs the current password). */
export function RecoveryCodesSection({ left, generatedAt }: { left: number; generatedAt: string | null }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [count, setCount] = useState(left);
  const [hasSet, setHasSet] = useState(!!generatedAt);

  return (
    <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5" data-testid="recovery-section">
      <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Recovery codes</h2>
      {codes ? (
        <RecoveryCodesPanel codes={codes} onDone={() => setCodes(null)} doneLabel="Done" />
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await adminApi<{ codes: string[] }>("/api/admin/account/recovery-codes", { method: "POST", json: { currentPassword: pw } });
              setCodes(r.codes);
              setCount(r.codes.length);
              setHasSet(true);
              setPw("");
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-zinc-600" data-testid="recovery-left">
            {hasSet
              ? `${count} of 10 unused. Use one to sign in if you lose your phone.`
              : "You don't have recovery codes yet. They're made at your first sign-in with a phone code, or make them here."}
          </p>
          {hasSet && count <= 3 && <Alert tone="warn">You&apos;re running low. Make a new set.</Alert>}
          <div>
            <Label htmlFor="rc-pw">Current password</Label>
            <Input id="rc-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required className="h-11" />
          </div>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="light" loading={busy} className="min-h-11" data-testid="regenerate-recovery">
            {hasSet ? "Make new codes (old ones stop working)" : "Make recovery codes"}
          </Button>
        </form>
      )}
    </section>
  );
}
