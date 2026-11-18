import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handle } from "@/lib/errors";
import { getCachedAvailability } from "@/lib/booking/availability-cache";
import { dateKeySchema, idSchema } from "@/lib/validation";
import { clientIp } from "@/lib/ratelimit";
import { windowLimit } from "@/lib/counter";
import { NETWORK_LIMIT_MESSAGE } from "@/lib/ip-limits";

export const dynamic = "force-dynamic";

const q = z.object({ courtId: idSchema, date: dateKeySchema });

export const GET = handle(async (req: Request) => {
  // Shared across all server instances (Postgres counter, or Upstash Redis if configured):
  // one row per network per minute, not one per request. [SEC-16][SEC-37]
  if (!(await windowLimit(`avail:${clientIp(req)}`, 120, 60_000))) throw new AppError("RATE_LIMITED", NETWORK_LIMIT_MESSAGE);
  const url = new URL(req.url);
  const { courtId, date } = q.parse({ courtId: url.searchParams.get("courtId"), date: url.searchParams.get("date") });
  const a = await getCachedAvailability(courtId, date);
  return NextResponse.json(
    { courtId, date, dayType: a.dayType, slotMinutes: a.court.slotMinutes, slots: a.slots, serverTime: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
});
