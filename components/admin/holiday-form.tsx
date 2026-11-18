"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input } from "@/components/ui/field";

export function HolidayForm() {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await adminApi("/api/admin/holidays", { method: "POST", json: { date, name } });
          setDate("");
          setName("");
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input type="date" aria-label="Holiday date" value={date} onChange={(e) => setDate(e.target.value)} required className="h-10 w-44 text-sm" />
      <Input aria-label="Holiday name" placeholder="e.g. Sankranti" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} className="h-10 w-56 text-sm" />
      <Button type="submit" variant="dark" size="sm" className="h-10" loading={busy}>Add holiday</Button>
      {error && <Alert className="w-full">{error}</Alert>}
    </form>
  );
}
