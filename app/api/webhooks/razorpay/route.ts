import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { handlePaymentWebhook } from "@/lib/booking/service";

/** Razorpay webhook (payment.captured / order.paid / payment.failed). Signature-verified, idempotent. */
export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  const r = await handlePaymentWebhook(raw, req.headers.get("x-razorpay-signature"), req.headers.get("x-razorpay-event-id"));
  return NextResponse.json({ ok: true, duplicate: r.duplicate });
});
