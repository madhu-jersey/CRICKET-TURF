"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";

export function DeleteButton({ url, label = "Delete", confirmText = "Are you sure?" }: { url: string; label?: string; confirmText?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(confirmText)) return;
          setBusy(true);
          setError(null);
          try {
            await adminApi(url, { method: "DELETE" });
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex min-h-11 items-center rounded-lg border border-red-300 px-3 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50 md:min-h-0 md:py-1"
      >
        {busy ? "…" : label}
      </button>
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
