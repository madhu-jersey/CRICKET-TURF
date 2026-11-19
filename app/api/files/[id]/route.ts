import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { windowLimit } from "@/lib/counter";
import { clientIp } from "@/lib/ratelimit";

/**
 * Serves gallery images stored in the database (STORAGE_PROVIDER=db). Public, read-only. [SEC-44]
 * - Only files that belong to a GalleryImage row are served: a StoredFile with no gallery entry
 *   (e.g. left behind, or added some other way) is 404. [SEC-51]
 * - Per-network limit of 300 requests a minute (shared fixed window), so the route can't be used to
 *   hammer the database. [SEC-51]
 * Stored images always went through lib/storage.ts › sanitizeImage() (WebP). Ids are random UUIDs
 * and files never change, so they cache for a year.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FILES_PER_IP_PER_MINUTE = 300;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await windowLimit(`files:${clientIp(req)}`, FILES_PER_IP_PER_MINUTE, 60_000))) {
    return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
  }
  const { id } = await ctx.params;
  if (!ID.test(id)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const [f] = await db
    .select({ contentType: schema.storedFiles.contentType, data: schema.storedFiles.data })
    .from(schema.storedFiles)
    .innerJoin(schema.galleryImages, eq(schema.galleryImages.storageKey, `db:${id}`))
    .where(and(eq(schema.storedFiles.id, id)))
    .limit(1);
  if (!f || !f.contentType.startsWith("image/")) return new Response("Not found", { status: 404 });
  const body = new Uint8Array(f.data);
  return new Response(body, {
    headers: {
      "Content-Type": f.contentType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // Opened directly, the image can't run anything or be framed.
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
