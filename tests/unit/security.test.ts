import { describe, expect, it } from "vitest";
import { checkOtp, generateOtpCode, hashOtp, OTP_MAX_ATTEMPTS } from "@/lib/otp";
import { checkoutSignature, verifyCheckoutSignature, verifyWebhookSignature, webhookSignature } from "@/lib/providers/payment";
import { signToken, verifyToken } from "@/lib/security";
import { normalizeIndianPhone, nameSchema } from "@/lib/validation";
import { createHmac } from "node:crypto";

const SECRET = "unit-secret";
const phone = "+919876543210";

describe("OTP", () => {
  const now = new Date("2026-11-17T10:00:00Z");
  const rec = (over: Partial<Parameters<typeof checkOtp>[0]> = {}) => ({
    phone,
    codeHash: hashOtp(phone, "123456", SECRET),
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    attempts: 0,
    consumedAt: null,
    ...over,
  });

  it("generates 6-digit codes", () => {
    for (let i = 0; i < 50; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });
  it("stores a hash, never the code", () => {
    const h = hashOtp(phone, "123456", SECRET);
    expect(h).not.toContain("123456");
    expect(h).toHaveLength(64);
    expect(hashOtp("+919876543211", "123456", SECRET)).not.toBe(h); // bound to the phone
  });
  it("accepts the right code", () => expect(checkOtp(rec(), "123456", SECRET, now)).toBe("OK"));
  it("rejects a wrong code", () => expect(checkOtp(rec(), "654321", SECRET, now)).toBe("INVALID"));
  it("expires after 5 minutes", () => {
    expect(checkOtp(rec(), "123456", SECRET, new Date(now.getTime() + 5 * 60_000))).toBe("EXPIRED");
  });
  it("is single use", () => expect(checkOtp(rec({ consumedAt: now }), "123456", SECRET, now)).toBe("CONSUMED"));
  it("locks after the attempts limit, even for the right code", () => {
    expect(checkOtp(rec({ attempts: OTP_MAX_ATTEMPTS }), "123456", SECRET, now)).toBe("TOO_MANY_ATTEMPTS");
    expect(checkOtp(rec({ attempts: OTP_MAX_ATTEMPTS - 1 }), "123456", SECRET, now)).toBe("OK");
  });
});

describe("Razorpay signatures", () => {
  const keySecret = "rzp_secret";
  it("matches Razorpay's documented HMAC-SHA256(order_id|payment_id)", () => {
    const expected = createHmac("sha256", keySecret).update("order_ABC|pay_XYZ").digest("hex");
    expect(checkoutSignature("order_ABC", "pay_XYZ", keySecret)).toBe(expected);
    expect(verifyCheckoutSignature("order_ABC", "pay_XYZ", expected, keySecret)).toBe(true);
  });
  it("rejects tampered checkout data", () => {
    const sig = checkoutSignature("order_ABC", "pay_XYZ", keySecret);
    expect(verifyCheckoutSignature("order_ABC", "pay_OTHER", sig, keySecret)).toBe(false);
    expect(verifyCheckoutSignature("order_ABC", "pay_XYZ", sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), keySecret)).toBe(false);
    expect(verifyCheckoutSignature("order_ABC", "pay_XYZ", "short", keySecret)).toBe(false);
  });
  it("verifies webhook bodies and rejects tampering", () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 30000 } } } });
    const sig = webhookSignature(body, "whsec");
    expect(verifyWebhookSignature(body, sig, "whsec")).toBe(true);
    expect(verifyWebhookSignature(body.replace("30000", "100"), sig, "whsec")).toBe(false);
    expect(verifyWebhookSignature(body, sig, "other-secret")).toBe(false);
  });
});

describe("signed tokens", () => {
  it("round-trips and expires", () => {
    const t = signToken({ phone, exp: Date.now() + 1000 }, SECRET);
    expect(verifyToken<{ phone: string; exp: number }>(t, SECRET)?.phone).toBe(phone);
    expect(verifyToken(t, "wrong")).toBeNull();
    expect(verifyToken(t, SECRET, Date.now() + 5000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ phone: "+919999999999", exp: Date.now() + 1000 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(body).toBeTruthy();
  });
});

describe("input validation", () => {
  it("normalizes Indian mobile numbers", () => {
    expect(normalizeIndianPhone("98765 43210")).toBe("+919876543210");
    expect(normalizeIndianPhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizeIndianPhone("09876543210")).toBe("+919876543210");
    expect(normalizeIndianPhone("5876543210")).toBeNull();
    expect(normalizeIndianPhone("987654321")).toBeNull();
  });
  it("sanitizes names", () => {
    expect(nameSchema.parse("  Ravi   <b>Teja</b> ")).toBe("Ravi bTeja/b");
    expect(nameSchema.safeParse("A").success).toBe(false);
    expect(nameSchema.safeParse("x".repeat(51)).success).toBe(false);
  });
});
