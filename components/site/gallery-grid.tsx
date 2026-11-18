"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Img = { id: string; url: string; alt: string; category: "CRICKET" | "PICKLEBALL" | "FACILITIES" };
const FILTERS = [
  { key: "ALL", label: "All" },
  { key: "CRICKET", label: "Cricket" },
  { key: "PICKLEBALL", label: "Pickleball" },
  { key: "FACILITIES", label: "Facilities" },
] as const;

export function GalleryGrid({ images }: { images: Img[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("ALL");
  const [open, setOpen] = useState<number | null>(null);
  const shown = filter === "ALL" ? images : images.filter((i) => i.category === filter);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const touchX = useRef<number | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  const move = useCallback((d: number) => setOpen((o) => (o === null ? o : (o + d + shown.length) % shown.length)), [shown.length]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open !== null && !dlg.open) {
      lastFocus.current = document.activeElement as HTMLElement;
      dlg.showModal();
    }
    if (open === null && dlg.open) dlg.close();
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, move]);

  const current = open !== null ? shown[open] : null;

  return (
    <>
      <div role="group" aria-label="Filter photos" className="no-scrollbar mt-8 flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn("rounded-full border px-4 py-2 text-sm font-semibold transition", filter === f.key ? "border-flood bg-flood text-flood-ink" : "border-white/20 text-mist hover:text-chalk")}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-10 text-mist">No photos in this category yet.</p>
      ) : (
        <ul className="mt-8 columns-2 gap-3 md:columns-3 [&>li]:mb-3">
          {shown.map((img, i) => (
            <li key={img.id} className="break-inside-avoid">
              <button type="button" onClick={() => setOpen(i)} className="group relative block w-full overflow-hidden rounded-2xl" aria-label={`Open photo: ${img.alt}`}>
                <Image
                  src={img.url}
                  alt={img.alt}
                  width={800}
                  height={i % 3 === 0 ? 1000 : i % 3 === 1 ? 600 : 800}
                  sizes="(min-width: 768px) 33vw, 50vw"
                  className="h-auto w-full object-cover transition duration-500 group-hover:scale-105"
                  style={{ aspectRatio: i % 3 === 0 ? "4/5" : i % 3 === 1 ? "4/3" : "1/1" }}
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      <dialog
        ref={dialogRef}
        aria-label="Photo viewer"
        onClose={() => {
          setOpen(null);
          lastFocus.current?.focus();
        }}
        onClick={(e) => e.target === e.currentTarget && setOpen(null)}
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-black/95 p-0 text-chalk backdrop:bg-black/80"
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
      >
        {current && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between p-4">
              <p className="text-sm text-mist">
                {open! + 1} / {shown.length}
              </p>
              <button type="button" onClick={() => setOpen(null)} className="grid size-11 place-items-center rounded-full bg-white/10 text-2xl" aria-label="Close">
                ×
              </button>
            </div>
            <div className="relative flex-1">
              <Image src={current.url} alt={current.alt} fill sizes="100vw" className="object-contain" />
            </div>
            <div className="flex items-center justify-between gap-4 p-4">
              <button type="button" onClick={() => move(-1)} className="grid size-12 place-items-center rounded-full bg-white/10 text-xl" aria-label="Previous photo">←</button>
              <p className="text-center text-sm">{current.alt}</p>
              <button type="button" onClick={() => move(1)} className="grid size-12 place-items-center rounded-full bg-white/10 text-xl" aria-label="Next photo">→</button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
