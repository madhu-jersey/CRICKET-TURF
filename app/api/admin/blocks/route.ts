import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { createBlocks } from "@/lib/booking/service";
import { getDb, schema } from "@/db/client";
import { addDays, dayOfWeek, istToUtc, timeToMinutes } from "@/lib/time";
import { closeTimeSchema, dateKeySchema, idSchema, sanitizeText, timeSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { randomToken } from "@/lib/security";

const body = z.object({
  courtId: idSchema,
  reason: z.enum(["MAINTENANCE", "TOURNAMENT", "PRIVATE_EVENT", "OTHER"]),
  note: z.string().max(200).transform(sanitizeText).optional(),
  startDate: dateKeySchema,
  endDate: dateKeySchema.optional(), // range: same times on every day from startDate to endDate
  startTime: timeSchema,
  endTime: closeTimeSchema,
  repeatWeekly: z.coerce.number().int().min(0).max(26).optional(), // recurring: N more weeks on the same weekday
});

/** Create a single block, a multi-day range or a weekly recurring block. Owner only. */
export const POST = adminRoute("OWNER", async (req, { admin }) => {
  const b = body.parse(await readJson(req));
  if (timeToMinutes(b.endTime) <= timeToMinutes(b.startTime)) throw new AppError("VALIDATION", "End time must be after start time.");
  const dates: string[] = [];
  if (b.repeatWeekly) {
    for (let w = 0; w <= b.repeatWeekly; w++) dates.push(addDays(b.startDate, w * 7));
  } else {
    const end = b.endDate ?? b.startDate;
    if (end < b.startDate) throw new AppError("VALIDATION", "End date must be on or after the start date.");
    for (let d = b.startDate; d <= end && dates.length < 120; d = addDays(d, 1)) dates.push(d);
  }
  const rows = await createBlocks(
    {
      courtId: b.courtId,
      reason: b.reason,
      note: b.note,
      recurrenceGroupId: dates.length > 1 ? `grp_${randomToken(8)}` : undefined,
      ranges: dates.map((d) => ({ startAt: istToUtc(d, b.startTime), endAt: istToUtc(d, b.endTime) })),
    },
    admin.email,
  );
  return NextResponse.json({ created: rows.length, weekday: dayOfWeek(b.startDate) }, { status: 201 });
});

export const DELETE = adminRoute("OWNER", async (req, { admin }) => {
  const u = new URL(req.url).searchParams;
  const id = u.get("id");
  const group = u.get("group");
  const db = await getDb();
  const removed = group
    ? await db.delete(schema.blockedSlots).where(eq(schema.blockedSlots.recurrenceGroupId, group)).returning()
    : id
      ? await db.delete(schema.blockedSlots).where(eq(schema.blockedSlots.id, id)).returning()
      : [];
  if (!removed.length) throw new AppError("NOT_FOUND", "Block not found");
  await audit(db, { actor: admin.email, action: "block.delete", entity: "BlockedSlot", entityId: group ?? id, before: removed.map((r) => ({ id: r.id, startAt: r.startAt, endAt: r.endAt, reason: r.reason })) });
  return NextResponse.json({ removed: removed.length });
});
