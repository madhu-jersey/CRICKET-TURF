import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { closeTimeSchema, idSchema, sanitizeText, timeSchema } from "@/lib/validation";
import { timeToMinutes } from "@/lib/time";
import { audit } from "@/lib/audit";

const patch = z.object({
  id: idSchema,
  isActive: z.boolean().optional(),
  name: z.string().transform(sanitizeText).pipe(z.string().min(2).max(60)).optional(),
  hours: z
    .array(z.object({ dayOfWeek: z.number().int().min(0).max(6), openTime: timeSchema, closeTime: closeTimeSchema, isClosed: z.boolean() }))
    .length(7)
    .optional(),
});

export const PATCH = adminRoute("OWNER", async (req, { admin }) => {
  const b = patch.parse(await readJson(req));
  const db = await getDb();
  const [court] = await db.select().from(schema.courts).where(eq(schema.courts.id, b.id));
  if (!court) throw new AppError("NOT_FOUND", "Court not found");
  await db.transaction(async (tx) => {
    if (b.isActive !== undefined || b.name) {
      await tx.update(schema.courts).set({ ...(b.isActive !== undefined ? { isActive: b.isActive } : {}), ...(b.name ? { name: b.name } : {}) }).where(eq(schema.courts.id, b.id));
      await audit(tx, { actor: admin.email, action: "court.update", entity: "Court", entityId: b.id, before: { isActive: court.isActive, name: court.name }, after: { isActive: b.isActive, name: b.name } });
    }
    if (b.hours) {
      for (const h of b.hours) {
        if (!h.isClosed && timeToMinutes(h.closeTime) <= timeToMinutes(h.openTime)) throw new AppError("VALIDATION", "Closing time must be after opening time.");
      }
      const before = await tx.select().from(schema.operatingHours).where(eq(schema.operatingHours.courtId, b.id));
      for (const h of b.hours) {
        const existing = before.find((x) => x.dayOfWeek === h.dayOfWeek);
        if (existing) await tx.update(schema.operatingHours).set(h).where(and(eq(schema.operatingHours.courtId, b.id), eq(schema.operatingHours.dayOfWeek, h.dayOfWeek)));
        else await tx.insert(schema.operatingHours).values({ ...h, courtId: b.id });
      }
      await audit(tx, { actor: admin.email, action: "court.hours", entity: "Court", entityId: b.id, before: before.map(({ dayOfWeek, openTime, closeTime, isClosed }) => ({ dayOfWeek, openTime, closeTime, isClosed })), after: b.hours });
    }
  });
  return NextResponse.json({ ok: true });
});
