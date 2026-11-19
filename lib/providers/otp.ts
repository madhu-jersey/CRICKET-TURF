/**
 * OTP delivery adapters, selected by OTP_PROVIDER=mock|whatsapp|sms.
 * - MockOtp: logs the code and returns it so the UI can show it (dev / DEMO_MODE only).
 * - WhatsAppOtp: sends the `otp_code` authentication template via the messaging provider.
 * - SmsOtp: MSG91 Flow API fallback.
 */
import "server-only";
import { env, mockOtpAllowed } from "@/lib/env";
import { getDb } from "@/db/client";
import { enqueueMessage, dispatchMessage, dispatchOnce } from "@/lib/messaging";

/** One WhatsApp try for codes, then SMS: a customer shouldn't wait more than ~5 s for the fallback. [SEC-50] */
export const OTP_WHATSAPP_TIMEOUT_MS = 5_000;
import { AppError } from "@/lib/errors";
import { maskForLog } from "@/lib/security";

export interface OtpProvider {
  readonly name: "mock" | "whatsapp" | "sms";
  /** Returns `devCode` only for the mock provider, so the demo UI can display it. */
  send(phone: string, code: string): Promise<{ devCode?: string }>;
}

export class MockOtp implements OtpProvider {
  readonly name = "mock" as const;
  async send(phone: string, code: string) {
    if (!mockOtpAllowed()) throw new AppError("PROVIDER_ERROR", "OTP provider is not configured");
    // Mock only (dev / DEMO_MODE): the code is shown on screen anyway. Real providers never log codes.
    console.info(`[otp:mock] ${maskForLog(phone)} → ${code}`);
    const db = await getDb();
    // Logged in the outbox so the demo shows what would be sent (code visible: it's a mock).
    const id = await enqueueMessage(db, { phone, template: "otp_code", params: { code }, optedIn: true });
    if (id) await dispatchMessage(id);
    return { devCode: code };
  }
}

export class WhatsAppOtp implements OtpProvider {
  readonly name = "whatsapp" as const;
  async send(phone: string, code: string) {
    const db = await getDb();
    // OTP is a user-initiated authentication message, so it is sent regardless of marketing opt-in.
    // The code itself is masked in the outbox log.
    const id = await enqueueMessage(db, { phone, template: "otp_code", params: { code }, logParams: { code: "••••••" }, optedIn: true });
    // One attempt with a 5 s deadline, no backoff sleeps. If it fails, the caller must know (and falls
    // back to SMS) instead of telling the user "code sent". [SEC-46][SEC-50]
    const status = id ? await dispatchOnce(id, { code }, OTP_WHATSAPP_TIMEOUT_MS) : "MISSING";
    if (status !== "SENT" && status !== "MOCKED") throw new AppError("PROVIDER_ERROR", "We couldn't send the code on WhatsApp. Please try again in a minute.");
    return {};
  }
}

export class SmsOtp implements OtpProvider {
  readonly name = "sms" as const;
  constructor(private authKey: string, private templateId: string) {
    if (!authKey || !templateId) throw new Error("MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required when OTP_PROVIDER=sms");
  }
  async send(phone: string, code: string) {
    const res = await fetch("https://control.msg91.com/api/v5/flow", {
      method: "POST",
      headers: { authkey: this.authKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ template_id: this.templateId, short_url: "0", recipients: [{ mobiles: phone.replace(/^\+/, ""), otp: code }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new AppError("PROVIDER_ERROR", "Could not send the SMS. Please try again.");
    return {};
  }
}

let override: OtpProvider | undefined;
export function setOtpProviderOverride(p: OtpProvider | undefined) {
  override = p;
}

export function getOtpProvider(): OtpProvider {
  if (override) return override;
  switch (env.otpProvider) {
    case "whatsapp":
      return new WhatsAppOtp();
    case "sms":
      return new SmsOtp(env.str("MSG91_AUTH_KEY"), env.str("MSG91_OTP_TEMPLATE_ID"));
    default:
      return new MockOtp();
  }
}

/** MSG91 SMS as a backup channel, if its keys are configured. */
export function smsFallback(): SmsOtp | null {
  const key = env.str("MSG91_AUTH_KEY");
  const tpl = env.str("MSG91_OTP_TEMPLATE_ID");
  return key && tpl ? new SmsOtp(key, tpl) : null;
}

/**
 * Sends a code over the configured OTP channel. If that channel fails (e.g. WhatsApp is down or the
 * template is rejected) and MSG91 is configured, the code goes by SMS instead. Used for customer
 * OTPs and admin login/reset codes. Throws PROVIDER_ERROR only when every channel failed. [SEC-46]
 */
export async function deliverOtpCode(phone: string, code: string): Promise<{ devCode?: string; channel: OtpProvider["name"] }> {
  const primary = getOtpProvider();
  try {
    return { ...(await primary.send(phone, code)), channel: primary.name };
  } catch (e) {
    const sms = primary.name === "sms" ? null : smsFallback();
    if (!sms) throw e;
    console.warn(`[otp] ${primary.name} delivery failed, falling back to SMS: ${e instanceof Error ? e.message : e}`);
    return { ...(await sms.send(phone, code)), channel: "sms" };
  }
}
