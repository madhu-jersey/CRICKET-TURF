/**
 * Payment providers. RazorpayProvider talks to the real Razorpay API (test or live keys);
 * MockPaymentProvider simulates it locally with the same signature scheme, so the mock checkout
 * goes through exactly the same server verification and webhook code as the real one.
 */
import "server-only";
import { env, mockPaymentAllowed } from "@/lib/env";
import { hmacHex, randomToken, safeEqual } from "@/lib/security";
import { AppError } from "@/lib/errors";

export type CreatedOrder = { orderId: string; amountPaise: number; currency: "INR" };
export type RefundInput = { paymentId: string; amountRupees: number; notes?: Record<string, string>; /** Stable key we store before calling; sent as receipt and notes.refund_key. */ refundKey?: string };
export type ProviderRefund = { id: string; amountRupees: number; notes: Record<string, string>; receipt: string | null };

/**
 * The provider may or may not have done what we asked: the request timed out, the network failed,
 * or the provider answered 5xx. For refunds this must be treated as "unknown" — not "failed" — and
 * reconciled later by looking the refund up by its key. [SEC-49]
 */
export class ProviderOutcomeUnknown extends AppError {
  constructor(message: string) {
    super("PROVIDER_ERROR", message);
    this.name = "ProviderOutcomeUnknown";
  }
}

export interface PaymentProvider {
  readonly name: "razorpay" | "mock";
  /** Public key id sent to the browser checkout. */
  readonly keyId: string;
  createOrder(input: { amountRupees: number; receipt: string; notes?: Record<string, string> }): Promise<CreatedOrder>;
  /** Signature from the checkout success callback: HMAC_SHA256(order_id|payment_id, key_secret). */
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  /** X-Razorpay-Signature: HMAC_SHA256(raw body, webhook_secret). */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  refund(input: RefundInput): Promise<{ refundId: string }>;
  /** All refunds made on a payment (to find one by its key after an unknown outcome). */
  listRefunds(paymentId: string): Promise<ProviderRefund[]>;
}

export function checkoutSignature(orderId: string, paymentId: string, keySecret: string) {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}
export function webhookSignature(rawBody: string, webhookSecret: string) {
  return hmacHex(webhookSecret, rawBody);
}
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string) {
  return safeEqual(checkoutSignature(orderId, paymentId, keySecret), signature);
}
export function verifyWebhookSignature(rawBody: string, signature: string, webhookSecret: string) {
  return safeEqual(webhookSignature(rawBody, webhookSecret), signature);
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay" as const;
  constructor(
    readonly keyId: string,
    private keySecret: string,
    private webhookSecret: string,
    private baseUrl = "https://api.razorpay.com/v1",
  ) {
    if (!keyId || !keySecret || !webhookSecret) {
      throw new Error("RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when PAYMENT_PROVIDER=razorpay");
    }
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64"),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // Timeout or network failure: Razorpay may have acted on the request. [SEC-49]
      throw new ProviderOutcomeUnknown(`Razorpay did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (res.status >= 500) throw new ProviderOutcomeUnknown(json.error?.description ?? `Razorpay error ${res.status}`);
    if (!res.ok) throw new AppError("PROVIDER_ERROR", json.error?.description ?? `Razorpay error ${res.status}`);
    return json;
  }

  async createOrder(input: { amountRupees: number; receipt: string; notes?: Record<string, string> }): Promise<CreatedOrder> {
    const amountPaise = input.amountRupees * 100;
    const order = await this.call<{ id: string }>("/orders", { amount: amountPaise, currency: "INR", receipt: input.receipt, notes: input.notes });
    return { orderId: order.id, amountPaise, currency: "INR" };
  }

  verifyCheckoutSignature(i: { orderId: string; paymentId: string; signature: string }) {
    return verifyCheckoutSignature(i.orderId, i.paymentId, i.signature, this.keySecret);
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    return verifyWebhookSignature(rawBody, signature, this.webhookSecret);
  }

  async refund(input: RefundInput) {
    const r = await this.call<{ id: string }>(`/payments/${encodeURIComponent(input.paymentId)}/refund`, {
      amount: input.amountRupees * 100,
      speed: "normal",
      ...(input.refundKey ? { receipt: input.refundKey } : {}),
      notes: { ...(input.notes ?? {}), ...(input.refundKey ? { refund_key: input.refundKey } : {}) },
    });
    return { refundId: r.id };
  }
  async listRefunds(paymentId: string): Promise<ProviderRefund[]> {
    const r = await this.call<{ items?: { id: string; amount: number; notes?: Record<string, string> | unknown[]; receipt?: string | null }[] }>(
      `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
    );
    return (r.items ?? []).map((x) => ({ id: x.id, amountRupees: Math.round(x.amount / 100), notes: Array.isArray(x.notes) ? {} : (x.notes ?? {}), receipt: x.receipt ?? null }));
  }
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;
  readonly keyId = "rzp_test_mock";
  constructor(readonly keySecret: string, readonly webhookSecret: string) {}

  async createOrder(input: { amountRupees: number }): Promise<CreatedOrder> {
    return { orderId: `order_mock_${randomToken(9)}`, amountPaise: input.amountRupees * 100, currency: "INR" };
  }
  verifyCheckoutSignature(i: { orderId: string; paymentId: string; signature: string }) {
    return verifyCheckoutSignature(i.orderId, i.paymentId, i.signature, this.keySecret);
  }
  verifyWebhookSignature(rawBody: string, signature: string) {
    return verifyWebhookSignature(rawBody, signature, this.webhookSecret);
  }
  /** Refunds made by the mock, per payment id, so lookups behave like Razorpay's. */
  readonly refunds = new Map<string, ProviderRefund[]>();
  async refund(input?: RefundInput) {
    const id = `rfnd_mock_${randomToken(9)}`;
    if (input) {
      const list = this.refunds.get(input.paymentId) ?? [];
      list.push({ id, amountRupees: input.amountRupees, notes: { ...(input.notes ?? {}), ...(input.refundKey ? { refund_key: input.refundKey } : {}) }, receipt: input.refundKey ?? null });
      this.refunds.set(input.paymentId, list);
    }
    return { refundId: id };
  }
  async listRefunds(paymentId: string) {
    return this.refunds.get(paymentId) ?? [];
  }
}

let cached: PaymentProvider | undefined;
let override: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (override) return override;
  if (cached) return cached;
  if (env.paymentProvider === "razorpay") {
    cached = new RazorpayProvider(env.str("RAZORPAY_KEY_ID"), env.str("RAZORPAY_KEY_SECRET"), env.str("RAZORPAY_WEBHOOK_SECRET"));
  } else {
    // Never fall back to the free mock checkout on a live site. [SEC-01]
    if (!mockPaymentAllowed()) throw new AppError("PROVIDER_ERROR", "Online payments are not configured. Please contact the venue.");
    cached = new MockPaymentProvider(hmacHex(env.appSecret, "mock-key-secret"), hmacHex(env.appSecret, "mock-webhook-secret"));
  }
  return cached;
}

export function setPaymentProviderOverride(p: PaymentProvider | undefined) {
  override = p;
}

/** Test helper: forget the cached provider so the next call re-reads the environment. */
export function resetPaymentProviderCache() {
  cached = undefined;
}
