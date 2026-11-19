"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";

export function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await adminApi<{ status: string }>(`/api/admin/messages/${id}/retry`, { method: "POST" });
            setMsg(`Now ${r.status}`);
            router.refresh();
          } catch (e) {
            setMsg((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 px-4 text-xs font-bold hover:border-ink disabled:opacity-50 md:min-h-0 md:py-1"
      >
        {busy ? "Retrying…" : "Retry"}
      </button>
      {msg && <span role="status" className="text-xs text-zinc-600">{msg}</span>}
    </span>
  );
}
