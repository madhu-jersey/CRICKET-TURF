import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { assertCron } from "@/lib/auth/cron";
import { expireHolds } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  assertCron(req);
  return NextResponse.json({ expired: await expireHolds() });
});
