"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";

/** Owner controls on the customer page: block/unblock online booking, WhatsApp opt-in/out. */
export function CustomerControls({ id, isBlocked, blockedReason, whatsappOptIn }: { id: string; isBlocked: boolean; blockedReason: string | null; whatsappOptIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = async (key: string, body: Record<string, boolean>) => {
    setBusy(key);
    setError(null);
    try {
      await adminApi("/api/admin/customers", { method: "PATCH", json: { id, ...body } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
      {isBlocked ? (
        <>
          <span className="rounded-full bg-red-100 px-3 py-1 text-sm font-bold text-red-900">Blocked from online booking{blockedReason ? ` · ${blockedReason}` : ""}</span>
          <Button variant="light" size="sm" loading={busy === "block"} onClick={() => patch("block", { isBlocked: false })}>Unblock</Button>
        </>
      ) : (
        <Button variant="light" size="sm" loading={busy === "block"} onClick={() => window.confirm("Block this number from booking online?") && patch("block", { isBlocked: true })}>
          Block online booking
        </Button>
      )}
      <Button variant="light" size="sm" loading={busy === "wa"} onClick={() => patch("wa", { whatsappOptIn: !whatsappOptIn })}>
        {whatsappOptIn ? "Stop WhatsApp messages" : "Allow WhatsApp messages"}
      </Button>
      {error && <Alert className="w-full">{error}</Alert>}
    </div>
  );
}
