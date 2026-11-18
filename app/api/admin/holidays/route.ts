import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, pgErrorCode, PG_UNIQUE_VIOLATION, schema } from "@/db/client";
import { dateKeySchema, sanitizeText } from "@/lib/validation";
import { audit } from "@/lib/audit";

const body = z.object({ date: dateKeySchema, name: z.string().transform(sanitizeText).pipe(z.string().min(2).max(60)) });

export const POST = adminRoute("OWNER", async (req, { admin }) => {
  const b = body.parse(await readJson(req));
  const db = await getDb();
  try {
    const [h] = await db.insert(schema.holidays).values(b).returning();
    await audit(db, { actor: admin.email, action: "holiday.create", entity: "Holiday", entityId: h.id, after: b });
  } catch (e) {
    if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw new AppError("VALIDATION", "That date is already a holiday.");
    throw e;
  }
  return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = adminRoute("OWNER", async (req, { admin }) => {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const db = await getDb();
  const [h] = await db.delete(schema.holidays).where(eq(schema.holidays.id, id)).returning();
  if (!h) throw new AppError("NOT_FOUND", "Holiday not found");
  await audit(db, { actor: admin.email, action: "holiday.delete", entity: "Holiday", entityId: id, before: h });
  return NextResponse.json({ ok: true });
});
