import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { bookingCodeSchema } from "@/lib/validation";
import { clientIp, enforceRateLimit } from "@/lib/ratelimit";
import { holdResponseFor } from "@/lib/booking/service";

/** Returns a payment order for a booking that is still on hold (used by "Retry payment"). */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ code: string }> }) => {
  const code = bookingCodeSchema.parse((await ctx.params).code);
  await enforceRateLimit(`pay-ip:${clientIp(req)}`, 40, 60 * 60_000);
  return NextResponse.json(await holdResponseFor(code, null));
});
