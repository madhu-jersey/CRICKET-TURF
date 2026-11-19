import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { assertCron } from "@/lib/auth/cron";
import { autoCompleteBookings, expireHolds, reconcileInFlightRefunds, retryPendingRefunds, sendReminders } from "@/lib/booking/service";
import { cleanupLimiterTables } from "@/lib/ratelimit";
import { redispatchStuck } from "@/lib/messaging";

export const dynamic = "force-dynamic";

/** Every 15 min: 2-hour reminders, plus a safety-net hold expiry, stuck-message retry and failed-refund retry. */
export const GET = handle(async (req: Request) => {
  assertCron(req);
  const expired = await expireHolds();
  const reminders = await sendReminders();
  const redispatched = await redispatchStuck();
  // Settle refunds with an unknown outcome first (look them up by key), then retry what is still owed. [SEC-49]
  const refundsReconciled = await reconcileInFlightRefunds();
  const refundsRetried = await retryPendingRefunds();
  const completed = await autoCompleteBookings(); // [SEC-59]
  const cleaned = await cleanupLimiterTables(); // [SEC-58]
  return NextResponse.json({ reminders, expired, redispatched, refundsReconciled, refundsRetried, completed, cleaned });
});
