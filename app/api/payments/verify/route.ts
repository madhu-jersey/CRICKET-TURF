import { NextResponse } from "next/server";
import { AppError, handle, readJson } from "@/lib/errors";
import { paymentVerifySchema } from "@/lib/validation";
import { getPaymentProvider } from "@/lib/providers/payment";
import { confirmPayment } from "@/lib/booking/service";

/** Checkout success callback. The signature is verified server-side before anything changes. */
export const POST = handle(async (req: Request) => {
  const body = paymentVerifySchema.parse(await readJson(req));
  if (!getPaymentProvider().verifyCheckoutSignature(body)) throw new AppError("INVALID_SIGNATURE", "Payment could not be verified.");
  const r = await confirmPayment({ orderId: body.orderId, paymentId: body.paymentId, via: "checkout" });
  return NextResponse.json(r);
});
