import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, handle, readJson } from "@/lib/errors";
import { checkoutSignature, getPaymentProvider, webhookSignature, type MockPaymentProvider } from "@/lib/providers/payment";
import { handlePaymentWebhook } from "@/lib/booking/service";
import { randomToken } from "@/lib/security";
import { getDb, schema } from "@/db/client";

const body = z.object({ orderId: z.string().min(1).max(100), outcome: z.enum(["success", "failure"]) });

/**
 * Mock checkout backend (PAYMENT_PROVIDER=mock only). Plays the part of Razorpay: it fires a
 * signed webhook into the real webhook handler, then returns a signed checkout response that the
 * browser sends to /api/payments/verify — the same path a real payment takes.
 */
export const POST = handle(async (req: Request) => {
  const provider = getPaymentProvider();
  if (provider.name !== "mock") throw new AppError("NOT_FOUND", "Not available");
  const mock = provider as MockPaymentProvider;
  const { orderId, outcome } = body.parse(await readJson(req));
  const db = await getDb();
  const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.providerOrderId, orderId));
  if (!payment) throw new AppError("NOT_FOUND", "Unknown order");
  const paymentId = `pay_mock_${randomToken(9)}`;
  const event = outcome === "success" ? "payment.captured" : "payment.failed";
  const raw = JSON.stringify({
    entity: "event",
    event,
    payload: {
      payment: {
        entity: { id: paymentId, order_id: orderId, amount: payment.amount * 100, currency: "INR", status: outcome === "success" ? "captured" : "failed", method: "upi" },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  await handlePaymentWebhook(raw, webhookSignature(raw, mock.webhookSecret), `evt_mock_${paymentId}`);
  if (outcome === "failure") return NextResponse.json({ failed: true, reason: "Payment declined by the bank (simulated)." });
  return NextResponse.json({ orderId, paymentId, signature: checkoutSignature(orderId, paymentId, mock.keySecret) });
});
