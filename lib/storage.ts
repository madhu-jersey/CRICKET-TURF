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

export async function storeImage(file: File): Promise<{ url: string; key: string }> {
  if (file.size > MAX_BYTES) throw new AppError("VALIDATION", "Image must be 4 MB or smaller.");
  const data = new Uint8Array(await file.arrayBuffer());
  const type = sniff(data);
  if (!type || !TYPES[type]) throw new AppError("VALIDATION", "Upload a JPG, PNG, WebP or AVIF image.");

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
