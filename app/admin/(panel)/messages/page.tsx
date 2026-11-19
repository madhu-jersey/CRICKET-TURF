import Link from "next/link";
import { desc, eq, count } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { PageHeader, StatusBadge } from "@/components/admin/shell";
import { RetryButton } from "@/components/admin/retry-button";
import { formatDateTime } from "@/lib/time";
import { env } from "@/lib/env";
import type { MessageStatus } from "@/db/schema";

export const metadata = { title: "Message outbox" };
const PAGE = 50;

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  await requireAdminPage("OWNER");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const status = ["QUEUED", "SENT", "FAILED", "MOCKED"].includes(sp.status ?? "") ? (sp.status as MessageStatus) : undefined;
  const db = await getDb();
  const where = status ? eq(schema.messageLogs.status, status) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(schema.messageLogs).where(where).orderBy(desc(schema.messageLogs.createdAt)).limit(PAGE).offset((page - 1) * PAGE),
    db.select({ n: count() }).from(schema.messageLogs).where(where),
  ]);
  return (
    <>
      <PageHeader title="Message outbox" />
      <p className="-mt-3 mb-4 text-sm text-zinc-600">
        Every WhatsApp / OTP message the system sends. Provider: <strong>{env.messagingProvider}</strong>
        {env.messagingProvider === "mock" && " — messages are logged here as MOCKED instead of being delivered."}
      </p>
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filter by status">
        {["", "MOCKED", "SENT", "QUEUED", "FAILED"].map((s) => (
          <Link key={s} href={s ? `?status=${s}` : "?"} aria-current={(status ?? "") === s ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-full border px-4 font-semibold md:min-h-0 md:py-1 ${(status ?? "") === s ? "border-ink bg-ink text-white" : "border-zinc-300 bg-white"}`}>
            {s || "All"}
          </Link>
        ))}
      </nav>
      <ul className="space-y-3">
        {rows.length === 0 && <li className="rounded-2xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">No messages.</li>}
        {rows.map((m) => (
          <li key={m.id} className="rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={m.status} />
              <strong>{m.template}</strong>
              <span className="text-zinc-500">→ {m.phone}</span>
              <span className="ml-auto text-xs text-zinc-500">{formatDateTime(m.createdAt)} · {m.attempts} attempt{m.attempts === 1 ? "" : "s"} · {m.provider}</span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-[#e7f6e9] p-3 font-sans text-sm text-zinc-800">{m.renderedText}</pre>
            {m.error && <p className="mt-2 text-xs text-red-700">{m.error}</p>}
            {(m.status === "FAILED" || m.status === "QUEUED") && <div className="mt-2"><RetryButton id={m.id} /></div>}
          </li>
        ))}
      </ul>
      <nav className="mt-4 flex justify-between text-sm" aria-label="Pagination">
        <span className="text-zinc-500">{n} message{n === 1 ? "" : "s"}</span>
        <span className="flex gap-2">
          {page > 1 && <Link className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 bg-white px-4 md:min-h-0 md:py-1" href={`?${new URLSearchParams({ ...(status ? { status } : {}), page: String(page - 1) })}`}>← Newer</Link>}
          {page * PAGE < n && <Link className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 bg-white px-4 md:min-h-0 md:py-1" href={`?${new URLSearchParams({ ...(status ? { status } : {}), page: String(page + 1) })}`}>Older →</Link>}
        </span>
      </nav>
    </>
  );
}
