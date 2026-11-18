import { NextResponse } from "next/server";
import { AppError, handle } from "@/lib/errors";
import { getVerifiedPhone } from "@/lib/auth/phone";
import { bookingsForPhone } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const phone = await getVerifiedPhone();
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Verify your phone number to see your bookings.");
  return NextResponse.json({ bookings: await bookingsForPhone(phone) }, { headers: { "Cache-Control": "no-store" } });
});
