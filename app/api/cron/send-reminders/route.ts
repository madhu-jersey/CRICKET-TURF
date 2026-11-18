import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { assertCron } from "@/lib/auth/cron";
import { expireHolds, sendReminders } from "@/lib/booking/service";
import { redispatchStuck } from "@/lib/messaging";

export const dynamic = "force-dynamic";

/** Every 15 min: 2-hour reminders, plus a safety-net hold expiry and stuck-message retry. */
export const GET = handle(async (req: Request) => {
  assertCron(req);
  const expired = await expireHolds();
  const reminders = await sendReminders();
  const redispatched = await redispatchStuck();
  return NextResponse.json({ reminders, expired, redispatched });
});
