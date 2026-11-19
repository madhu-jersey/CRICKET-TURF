import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { closeTimeSchema, idSchema, timeSchema } from "@/lib/validation";
import { timeToMinutes } from "@/lib/time";
import { audit } from "@/lib/audit";
import { invalidateCourtConfig } from "@/lib/booking/availability-cache";

const body = z.object({
  courtId: idSchema,
  dayType: z.enum(["WEEKDAY", "WEEKEND", "HOLIDAY"]),
  rules: z.array(z.object({ startTime: timeSchema, endTime: closeTimeSchema, pricePerSlot: z.coerce.number().int().min(0).max(100000) })).max(24),
  applyToSport: z.boolean().optional(),
});

/** Replaces all pricing rules for one court (or every court of that sport) and day type. */
export const PUT = adminRoute("OWNER", async (req, { admin }) => {
  const b = body.parse(await readJson(req));
  const sorted = [...b.rules].sort((x, y) => timeToMinutes(x.startTime) - timeToMinutes(y.startTime));
  for (let i = 0; i < sorted.length; i++) {
    if (timeToMinutes(sorted[i].endTime) <= timeToMinutes(sorted[i].startTime)) throw new AppError("VALIDATION", "Each band's end time must be after its start time.");
    if (i > 0 && timeToMinutes(sorted[i].startTime) < timeToMinutes(sorted[i - 1].endTime)) throw new AppError("VALIDATION", "Time bands overlap. Adjust them so they don't.");
  }
  const db = await getDb();
  let courtIds = [b.courtId];
  if (b.applyToSport) {
    const [c] = await db.select().from(schema.courts).where(eq(schema.courts.id, b.courtId));
    if (c) courtIds = (await db.select({ id: schema.courts.id }).from(schema.courts).where(eq(schema.courts.sportId, c.sportId))).map((x) => x.id);
  }
  await db.transaction(async (tx) => {
    for (const courtId of courtIds) {
      const before = await tx.select().from(schema.pricingRules).where(and(eq(schema.pricingRules.courtId, courtId), eq(schema.pricingRules.dayType, b.dayType)));
      await tx.delete(schema.pricingRules).where(and(eq(schema.pricingRules.courtId, courtId), eq(schema.pricingRules.dayType, b.dayType)));
      if (sorted.length) await tx.insert(schema.pricingRules).values(sorted.map((r) => ({ ...r, courtId, dayType: b.dayType })));
      await audit(tx, { actor: admin.email, action: "pricing.update", entity: "Court", entityId: courtId, before: before.map(({ startTime, endTime, pricePerSlot }) => ({ startTime, endTime, pricePerSlot })), after: { dayType: b.dayType, rules: sorted } });
    }
  });
  await invalidateCourtConfig(courtIds); // new prices show on the next poll [SEC-60]
  return NextResponse.json({ ok: true, courts: courtIds.length });
});
