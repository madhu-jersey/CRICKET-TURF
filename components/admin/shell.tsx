"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin/client";
import { cn } from "@/lib/utils";
import { CalendarIcon, UserIcon } from "@/components/ui/icons";

function HomeIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      <path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" />
    </svg>
  );
}
function ListIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden {...p}>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}
function MenuIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

const NAV: { href: string; label: string; owner?: boolean }[] = [
  { href: "/admin", label: "Overview", owner: true },
  { href: "/admin/schedule", label: "Schedule" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/walk-in", label: "Walk-in / phone" },
  { href: "/admin/blocked", label: "Blocked slots", owner: true },
  { href: "/admin/pricing", label: "Pricing", owner: true },
  { href: "/admin/courts", label: "Courts & hours", owner: true },
  { href: "/admin/customers", label: "Customers", owner: true },
  { href: "/admin/gallery", label: "Gallery", owner: true },
  { href: "/admin/messages", label: "Message outbox", owner: true },
  { href: "/admin/settings", label: "Settings", owner: true },
  { href: "/admin/audit", label: "Audit log", owner: true },
];

export function AdminShell({ children, name, email, role }: { children: React.ReactNode; name: string; email: string; role: "OWNER" | "STAFF" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const items = NAV.filter((n) => !n.owner || role === "OWNER");
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  const logout = async () => {
    await adminApi("/api/admin/login", { method: "DELETE" }).catch(() => {});
    window.location.href = "/admin/login";
  };

  const nav = (
    <nav aria-label="Admin" className="flex flex-col gap-0.5">
      {items.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={active(n.href) ? "page" : undefined}
          className={cn("rounded-lg px-3 py-2 text-sm font-semibold transition", active(n.href) ? "bg-ink text-flood" : "text-zinc-600 hover:bg-zinc-200 hover:text-ink")}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="lg:grid lg:min-h-dvh lg:grid-cols-[232px_1fr]">
      <aside className="hidden border-r border-zinc-200 bg-white p-4 lg:flex lg:flex-col">
        <Link href="/" className="mb-6 block px-3 font-display text-xl font-extrabold uppercase">
          Boundary<span className="text-pitch-600">Box</span> <span className="text-xs text-zinc-500">admin</span>
        </Link>
        {nav}
        <div className="mt-auto border-t border-zinc-200 px-3 pt-4 text-xs text-zinc-500">
          <p className="font-semibold text-ink">{name}</p>
          <p>{email} · {role.toLowerCase()}</p>
          <button onClick={logout} className="mt-2 font-semibold text-ink underline">Sign out</button>
        </div>
      </aside>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-200 bg-white/90 px-4 backdrop-blur lg:hidden">
        <Link href={role === "OWNER" ? "/admin" : "/admin/schedule"} className="font-display text-lg font-extrabold uppercase">
          Boundary<span className="text-pitch-600">Box</span>
        </Link>
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-bold uppercase text-zinc-600">{role === "OWNER" ? "Owner" : "Staff"}</span>
      </header>

      {/* "More" sheet with every page */}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div id="admin-mobile-nav" role="dialog" aria-modal="true" aria-label="All pages" className="absolute inset-x-0 bottom-0 max-h-[80dvh] animate-[sheet_.3s_cubic-bezier(.2,.9,.3,1)_both] overflow-y-auto rounded-t-[28px] bg-white p-4 pb-[max(env(safe-area-inset-bottom),20px)]">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-zinc-300" />
            <nav aria-label="All admin pages" className="grid grid-cols-2 gap-2">
              {items.map((n) => (
                <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} className={cn("rounded-2xl px-4 py-3.5 text-[15px] font-semibold", active(n.href) ? "bg-ink text-flood" : "bg-zinc-100 text-ink")}>
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="mt-4 flex items-center justify-between rounded-2xl border border-zinc-200 px-4 py-3 text-sm">
              <span className="min-w-0 truncate">{name} · {email}</span>
              <button onClick={logout} className="shrink-0 font-bold underline">Sign out</button>
            </div>
          </div>
        </div>
      )}

      <main className="min-w-0 p-4 pb-28 sm:p-6 sm:pb-28 lg:p-8">{children}</main>

      {/* Mobile bottom tabs: the pages used at the ground */}
      <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-40 grid border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" style={{ gridTemplateColumns: `repeat(${role === "OWNER" ? 5 : 4}, 1fr)` }}>
        {[
          ...(role === "OWNER" ? [{ href: "/admin", label: "Today", Icon: HomeIcon }] : []),
          { href: "/admin/schedule", label: "Schedule", Icon: CalendarIcon },
          { href: "/admin/bookings", label: "Bookings", Icon: ListIcon },
          { href: "/admin/walk-in", label: "Walk-in", Icon: UserIcon },
        ].map(({ href, label, Icon }) => (
          <Link key={href} href={href} aria-current={active(href) ? "page" : undefined} className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-bold transition", active(href) ? "text-pitch-600" : "text-zinc-500")}>
            <span className={cn("grid h-8 w-12 place-items-center rounded-full transition", active(href) && "bg-flood/40")}>
              <Icon className="size-5" />
            </span>
            {label}
          </Link>
        ))}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="admin-mobile-nav" className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-bold text-zinc-500">
          <span className="grid h-8 w-12 place-items-center rounded-full"><MenuIcon className="size-5" /></span>
          More
        </button>
      </nav>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 className="font-display text-[28px] font-extrabold uppercase leading-none sm:text-4xl">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Card({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <section className={cn("rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5", className)}>
      {title && <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-500">{title}</h2>}
      {children}
    </section>
  );
}

const STATUS_STYLE: Record<string, string> = {
  PENDING_PAYMENT: "bg-amber-100 text-amber-900",
  CONFIRMED: "bg-emerald-100 text-emerald-900",
  COMPLETED: "bg-zinc-200 text-zinc-800",
  EXPIRED: "bg-zinc-100 text-zinc-500",
  CANCELLED: "bg-red-100 text-red-900",
  REFUNDED: "bg-sky-100 text-sky-900",
  NO_SHOW: "bg-orange-100 text-orange-900",
  MOCKED: "bg-violet-100 text-violet-900",
  SENT: "bg-emerald-100 text-emerald-900",
  QUEUED: "bg-amber-100 text-amber-900",
  FAILED: "bg-red-100 text-red-900",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold", STATUS_STYLE[status] ?? "bg-zinc-100")}>{status.replace("_", " ")}</span>;
}
