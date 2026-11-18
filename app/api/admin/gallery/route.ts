import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, max } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { sanitizeText } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { deleteImage, storeImage } from "@/lib/storage";

const CATEGORY = z.enum(["CRICKET", "PICKLEBALL", "FACILITIES"]);
const ALT = z.string().transform(sanitizeText).pipe(z.string().min(3, "Describe the photo (alt text)").max(160));

export const POST = adminRoute("OWNER", async (req, { admin }) => {
  const form = await req.formData().catch(() => null);
  if (!form) throw new AppError("VALIDATION", "Upload a file");
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose an image to upload");
  const category = CATEGORY.parse(form.get("category"));
  const alt = ALT.parse(form.get("alt") ?? "");
  const stored = await storeImage(file);
  const db = await getDb();
  const [{ m }] = await db.select({ m: max(schema.galleryImages.sortOrder) }).from(schema.galleryImages);
  const [img] = await db.insert(schema.galleryImages).values({ url: stored.url, storageKey: stored.key, category, alt, sortOrder: (m ?? 0) + 1 }).returning();
  await audit(db, { actor: admin.email, action: "gallery.upload", entity: "GalleryImage", entityId: img.id, after: { category, alt } });
  return NextResponse.json(img, { status: 201 });
});

const patch = z.object({ id: z.string().min(1), alt: ALT.optional(), category: CATEGORY.optional(), isFeatured: z.boolean().optional() });

export const PATCH = adminRoute("OWNER", async (req, { admin }) => {
  const b = patch.parse(await readJson(req));
  const db = await getDb();
  const { id, ...set } = b;
  const [img] = await db.update(schema.galleryImages).set(set).where(eq(schema.galleryImages.id, id)).returning();
  if (!img) throw new AppError("NOT_FOUND", "Image not found");
  await audit(db, { actor: admin.email, action: "gallery.update", entity: "GalleryImage", entityId: id, after: set });
  return NextResponse.json(img);
});

/** Reorder: body { ids: string[] } in the new order. */
export const PUT = adminRoute("OWNER", async (req, { admin }) => {
  const { ids } = z.object({ ids: z.array(z.string().min(1)).max(500) }).parse(await readJson(req));
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx.update(schema.galleryImages).set({ sortOrder: i }).where(eq(schema.galleryImages.id, ids[i]));
    await audit(tx, { actor: admin.email, action: "gallery.reorder", entity: "GalleryImage", after: { count: ids.length } });
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = adminRoute("OWNER", async (req, { admin }) => {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const db = await getDb();
  const [img] = await db.delete(schema.galleryImages).where(eq(schema.galleryImages.id, id)).returning();
  if (!img) throw new AppError("NOT_FOUND", "Image not found");
  if (img.storageKey) await deleteImage(img.storageKey).catch((e) => console.warn("[gallery] delete file failed", e));
  await audit(db, { actor: admin.email, action: "gallery.delete", entity: "GalleryImage", entityId: id, before: { url: img.url, alt: img.alt } });
  return NextResponse.json({ ok: true });
});
