/** Server-only configuration. Never import this from a client component. */
import "server-only";

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const env = {
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
  /** DEMO_MODE defaults to true so the demo works out of the box. Set DEMO_MODE=false to go live. */
  get demoMode() {
    return str("DEMO_MODE", "true") !== "false";
  },
  get appSecret() {
    const s = str("APP_SECRET");
    if (!s) {
      if (process.env.NODE_ENV === "production" && str("DEMO_MODE", "true") === "false") {
        throw new Error("APP_SECRET must be set in production");
      }
      return "dev-only-insecure-secret-change-me";
    }
    return s;
  },
  get siteUrl() {
    return str("NEXT_PUBLIC_SITE_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get paymentProvider(): "mock" | "razorpay" {
    return str("PAYMENT_PROVIDER", "mock") === "razorpay" ? "razorpay" : "mock";
  },
  get messagingProvider(): "mock" | "meta" | "bsp" {
    const v = str("MESSAGING_PROVIDER", "mock");
    return v === "meta" || v === "bsp" ? v : "mock";
  },
  get otpProvider(): "mock" | "whatsapp" | "sms" {
    const v = str("OTP_PROVIDER", "mock");
    return v === "whatsapp" || v === "sms" ? v : "mock";
  },
  get messageLanguage(): "en" | "te" {
    return str("MESSAGE_LANGUAGE", "en") === "te" ? "te" : "en";
  },
  get cronSecret() {
    return str("CRON_SECRET");
  },
  get messageRetryBaseMs() {
    return Number(str("MESSAGE_RETRY_BASE_MS", "1000"));
  },
  str,
};

/** The mock OTP provider (code shown on screen) is only allowed outside production or in demo mode. */
export function mockOtpAllowed() {
  return !env.isProduction || env.demoMode;
}
