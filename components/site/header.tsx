"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { siteConfig } from "@/config/site";
import { buttonClass } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/book?sport=cricket", label: "Cricket" },
  { href: "/book?sport=pickleball", label: "Pickleball" },
  { href: "/gallery", label: "Gallery" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/my-bookings", label: "My bookings" },
];

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("group flex items-center gap-2.5", className)} aria-label={`${siteConfig.name} home`}>
      <span aria-hidden className="grid size-9 place-items-center rounded-lg border-2 border-flood">
        <span className="flex gap-[3px]">
          <span className="h-4 w-[3px] rounded bg-chalk" />
          <span className="h-4 w-[3px] rounded bg-chalk" />
          <span className="h-4 w-[3px] rounded bg-chalk" />
        </span>
      </span>
      <span className="font-display text-xl font-extrabold uppercase leading-none tracking-wide text-chalk">
        Boundary<span className="text-flood">Box</span>
        <span className="block text-[11px] font-semibold tracking-[0.32em] text-mist">Arena</span>
      </span>
    </Link>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={cn("sticky top-0 z-40 transition-colors duration-300", scrolled || open ? "bg-pitch-950/92 backdrop-blur-md" : "bg-transparent")}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-full px-3.5 py-2 text-sm font-semibold text-mist transition hover:text-chalk">
              {n.label}
            </Link>
          ))}
          <Link href="/book" className={buttonClass("flood", "sm", "ml-2 px-5")}>
            Book now
          </Link>
        </nav>
        <button
          type="button"
          className="grid size-11 place-items-center rounded-full text-chalk md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="relative block h-3.5 w-5">
            <span className={cn("absolute left-0 h-0.5 w-5 bg-current transition", open ? "top-1.5 rotate-45" : "top-0")} />
            <span className={cn("absolute left-0 top-1.5 h-0.5 w-5 bg-current transition", open && "opacity-0")} />
            <span className={cn("absolute left-0 h-0.5 w-5 bg-current transition", open ? "top-1.5 -rotate-45" : "top-3")} />
          </span>
        </button>
      </div>
      <nav id="mobile-nav" aria-label="Mobile" hidden={!open} className="border-t border-white/10 px-4 pb-6 pt-2 md:hidden">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className="block border-b border-white/5 py-3.5 font-display text-2xl font-bold uppercase tracking-wide text-chalk">
            {n.label}
          </Link>
        ))}
        <Link href="/book" className={buttonClass("flood", "lg", "mt-5 w-full")}>
          Book a slot
        </Link>
      </nav>
    </header>
  );
}
