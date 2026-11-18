import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { GalleryGrid } from "@/components/site/gallery-grid";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Gallery",
  description: "Photos of our floodlit box cricket arena, pickleball courts and facilities.",
  alternates: { canonical: "/gallery" },
};

export default async function GalleryPage() {
  const db = await getDb();
  const images = await db.select().from(schema.galleryImages).orderBy(asc(schema.galleryImages.sortOrder));
  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12">
      <h1 className="font-display text-5xl font-extrabold uppercase sm:text-6xl">Gallery</h1>
      <p className="mt-2 text-mist">The arena, the courts and the people who play on them.</p>
      <GalleryGrid images={images.map((i) => ({ id: i.id, url: i.url, alt: i.alt, category: i.category }))} />
    </div>
  );
}
