import { asc } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { PageHeader } from "@/components/admin/shell";
import { GalleryManager } from "@/components/admin/gallery-manager";

export const metadata = { title: "Gallery" };

export default async function GalleryAdminPage() {
  await requireAdminPage("OWNER");
  const db = await getDb();
  const images = await db.select().from(schema.galleryImages).orderBy(asc(schema.galleryImages.sortOrder));
  return (
    <>
      <PageHeader title="Gallery" />
      <GalleryManager images={images.map((i) => ({ id: i.id, url: i.url, alt: i.alt, category: i.category, isFeatured: i.isFeatured }))} />
    </>
  );
}
