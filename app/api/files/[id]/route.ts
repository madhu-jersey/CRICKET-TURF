import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";

/**
 * Serves gallery images stored in the database (STORAGE_PROVIDER=db). Public, read-only.
 * Only images that went through lib/storage.ts › sanitizeImage() are stored (always WebP), so the
 * bytes are safe to serve. Ids are random UUIDs and files never change, so they cache for a year.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID.test(id)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const [f] = await db.select().from(schema.storedFiles).where(eq(schema.storedFiles.id, id));
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
