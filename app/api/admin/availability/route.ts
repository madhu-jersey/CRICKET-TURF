import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminRoute } from "@/lib/admin/route";
import { loadAvailability } from "@/lib/booking/data";
import { dateKeySchema, idSchema } from "@/lib/validation";

/** Admin variant: any future date, and slots that have started but not ended (for walk-ins). */
export const GET = adminRoute("STAFF", async (req) => {
  const u = new URL(req.url).searchParams;
  const { courtId, date } = z.object({ courtId: idSchema, date: dateKeySchema }).parse({ courtId: u.get("courtId"), date: u.get("date") });
  const a = await loadAvailability(await getDb(), courtId, date, new Date(), { admin: true });
  return NextResponse.json({ slots: a.slots });
});
