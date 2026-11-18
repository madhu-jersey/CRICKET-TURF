"use client";

import { useEffect, useState } from "react";

const COLORS = ["#d6ff3d", "#ffffff", "#b8e61a", "#2a6a45", "#ffd166"];

/** One-shot confetti burst + animated tick for the "You're booked!" screen. Skipped for reduced motion. */
export function Celebrate() {
  const [pieces, setPieces] = useState<{ dx: number; dy: number; rot: number; delay: number; color: string; w: number; h: number; left: number }[]>([]);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPieces(
      Array.from({ length: 70 }, (_, i) => ({
        dx: (Math.random() - 0.5) * 520,
        dy: 260 + Math.random() * 420,
        rot: (Math.random() - 0.5) * 900,
        delay: Math.random() * 180,
        color: COLORS[i % COLORS.length],
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 10,
        left: 50 + (Math.random() - 0.5) * 20,
      })),
    );
    navigator.vibrate?.(40);
  }, []);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-24 z-50 h-0">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 block rounded-[2px]"
          style={
            {
              left: `${p.left}%`,
              width: p.w,
              height: p.h,
              background: p.color,
              animation: `confetti 1.6s cubic-bezier(.15,.6,.3,1) ${p.delay}ms both`,
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              "--rot": `${p.rot}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

export function SuccessTick() {
  return (
    <div className="relative mx-auto size-24">
      <span className="absolute inset-0 animate-ping rounded-full bg-flood/30 [animation-iteration-count:2] motion-reduce:hidden" />
      <svg viewBox="0 0 52 52" className="relative size-24 animate-pop">
        <circle cx="26" cy="26" r="24" fill="var(--color-flood)" />
        <path d="M15 27l7 7 15-16" fill="none" stroke="var(--color-flood-ink)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" style={{ strokeDasharray: 48, animation: "draw .5s .25s ease-out both" }} />
      </svg>
    </div>
  );
}
