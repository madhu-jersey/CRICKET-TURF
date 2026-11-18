import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { handle } from "@/lib/errors";
import { loadAvailability } from "@/lib/booking/data";
import { dateKeySchema, idSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const q = z.object({ courtId: idSchema, date: dateKeySchema });

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const { courtId, date } = q.parse({ courtId: url.searchParams.get("courtId"), date: url.searchParams.get("date") });
  const a = await loadAvailability(await getDb(), courtId, date, new Date());
  return NextResponse.json(
    { courtId, date, dayType: a.dayType, slotMinutes: a.court.slotMinutes, slots: a.slots, serverTime: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
});
