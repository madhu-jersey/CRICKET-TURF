/**
 * Image storage for the gallery manager, selected by STORAGE_PROVIDER:
 * - db (default): bytes in the StoredFile table, served from /api/files/:id. Works everywhere, no setup.
 * - supabase: Supabase Storage via its REST API (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET; bucket must be public).
 */
import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { randomToken } from "@/lib/security";

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };

/** Checks magic bytes so a renamed file can't pass as an image. */
function sniff(buf: Uint8Array): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (String.fromCharCode(...buf.slice(0, 4)) === "RIFF" && String.fromCharCode(...buf.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...buf.slice(4, 12)).startsWith("ftypavi")) return "image/avif";
  return null;
}

/**
 * Re-encodes an uploaded image to WebP: strips EXIF/GPS and any other metadata, rejects images
 * over 40 MP (decompression bombs), and caps the long edge at 2400 px. Whatever bytes the uploader
 * sent never reach storage — only a freshly encoded image does. [SEC-20]
 */
export async function sanitizeImage(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const { default: sharp } = await import("sharp");
  try {
    const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    if (meta.width < 200 || meta.height < 200) throw new AppError("VALIDATION", "Image is too small (minimum 200 × 200 px).");
    const out = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate() // apply EXIF orientation before the metadata is dropped
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return new Uint8Array(out);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("VALIDATION", "This image couldn't be read or is too large. Try a smaller JPG or PNG.");
  }
}

export async function storeImage(file: File): Promise<{ url: string; key: string }> {
  if (file.size > MAX_BYTES) throw new AppError("VALIDATION", "Image must be 4 MB or smaller.");
  const raw = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniff(raw);
  if (!sniffed || !TYPES[sniffed]) throw new AppError("VALIDATION", "Upload a JPG, PNG, WebP or AVIF image.");
  const data = await sanitizeImage(raw);
  const type = "image/webp";

  if (env.str("STORAGE_PROVIDER", "db") === "supabase") {
    const base = env.str("SUPABASE_URL").replace(/\/$/, "");
    const key = env.str("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = env.str("SUPABASE_BUCKET", "gallery");
    if (!base || !key) throw new AppError("PROVIDER_ERROR", "Supabase storage is not configured.");
    const path = `${Date.now()}-${randomToken(6)}.${TYPES[type]}`;
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": type, "x-upsert": "false" },
      body: data,
    });
    if (!res.ok) throw new AppError("PROVIDER_ERROR", "Upload to storage failed.");
    return { url: `${base}/storage/v1/object/public/${bucket}/${path}`, key: `supabase:${bucket}/${path}` };
  }

  const db = await getDb();
  const [f] = await db.insert(schema.storedFiles).values({ contentType: type, data }).returning({ id: schema.storedFiles.id });
  return { url: `/api/files/${f.id}`, key: `db:${f.id}` };
}

export async function deleteImage(key: string) {
  if (key.startsWith("db:")) {
    const db = await getDb();
    await db.delete(schema.storedFiles).where(eq(schema.storedFiles.id, key.slice(3)));
  } else if (key.startsWith("supabase:")) {
    const base = env.str("SUPABASE_URL").replace(/\/$/, "");
    const [bucket, ...rest] = key.slice(9).split("/");
    await fetch(`${base}/storage/v1/object/${bucket}/${rest.join("/")}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.str("SUPABASE_SERVICE_ROLE_KEY")}` } });
  }
}
