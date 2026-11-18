import { NextResponse } from "next/server";
import { clearPhoneCookie, getVerifiedPhone } from "@/lib/auth/phone";
import { ensureDeviceId } from "@/lib/auth/device";
import { offerStatus } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

/**
 * The phone verified in this browser (httpOnly cookie) and the first-booking offer it qualifies
 * for on this device, so the booking page can show it before payment. Also makes sure this
 * browser has a device ID. The server re-checks everything when the slot is held.
 */
export async function GET() {
  const deviceId = await ensureDeviceId();
  const phone = await getVerifiedPhone();
  const offer = phone ? await offerStatus(phone, deviceId) : { percent: 0, reason: null };
  return NextResponse.json({ phone, offerPercent: offer.percent, offerReason: offer.reason }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await clearPhoneCookie();
  return NextResponse.json({ ok: true });
}
