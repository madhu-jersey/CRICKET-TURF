"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { buttonClass } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DemoBanner() {
  return (
    <div className="bg-flood px-4 py-1.5 text-center text-[13px] font-bold text-flood-ink">
      Demo: payments and messages are simulated — no real money is charged.
    </div>
  );
}

/** Sticky thumb-zone "Book Now" bar on mobile, hidden on the booking flow itself. */
export function MobileBookBar() {
  const pathname = usePathname();
  if (pathname.startsWith("/book") || pathname.startsWith("/booking")) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-pitch-950/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur md:hidden">
      <div className="flex gap-3">
        <Link href="/book?sport=cricket" className={buttonClass("flood", "md", "flex-1")}>
          Book cricket
        </Link>
        <Link href="/book?sport=pickleball" className={buttonClass("outline", "md", "flex-1")}>
          Pickleball
        </Link>
      </div>
    </div>
  );
}

/** Fades children in when scrolled into view (disabled by prefers-reduced-motion in CSS). */
export function Reveal({ children, className, delay = 0, as: Tag = "div" }: { children: React.ReactNode; className?: string; delay?: number; as?: "div" | "section" | "li" }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      el.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} className={cn("reveal", className)} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </Tag>
  );
}
