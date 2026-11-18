import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/booking/data";
import { phoneSchema, sanitizeText } from "@/lib/validation";
import { audit } from "@/lib/audit";

const text = (max: number) => z.string().transform(sanitizeText).pipe(z.string().min(2).max(max));

const body = z
  .object({
    advanceType: z.enum(["FIXED", "PERCENT"]),
    advanceValue: z.coerce.number().int().min(0).max(100000),
    holdMinutes: z.coerce.number().int().min(2).max(60),
    cancellationCutoffHours: z.coerce.number().int().min(0).max(168),
    refundPercentBeforeCutoff: z.coerce.number().int().min(0).max(100),
    maxDaysAhead: z.coerce.number().int().min(1).max(90),
    newCustomerDiscountPercent: z.coerce.number().int().min(0).max(50),
    ownerAlertPhone: z.union([phoneSchema, z.literal("")]).transform((v) => v || null),
    businessName: text(80),
    address: text(200),
    mapLink: z.string().trim().url("Enter a full map link starting with https://").max(500),
    phone: phoneSchema,
  })
  .refine((v) => v.advanceType !== "PERCENT" || v.advanceValue <= 100, { message: "Percent advance must be 100 or less", path: ["advanceValue"] });

export const PUT = adminRoute("OWNER", async (req, { admin }) => {
  const b = body.parse(await readJson(req));
  const db = await getDb();
  const before = await getSettings(db);
  await db
    .insert(schema.settings)
    .values({ id: 1, ...b, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.id, set: { ...b, updatedAt: new Date() } });
  await audit(db, { actor: admin.email, action: "settings.update", entity: "Settings", entityId: "1", before, after: b });
  return NextResponse.json({ ok: true });
});
