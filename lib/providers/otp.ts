/**
 * OTP delivery adapters, selected by OTP_PROVIDER=mock|whatsapp|sms.
 * - MockOtp: logs the code and returns it so the UI can show it (dev / DEMO_MODE only).
 * - WhatsAppOtp: sends the `otp_code` authentication template via the messaging provider.
 * - SmsOtp: MSG91 Flow API fallback.
 */
import "server-only";
import { env, mockOtpAllowed } from "@/lib/env";
import { getDb } from "@/db/client";
import { enqueueMessage, dispatchMessage } from "@/lib/messaging";
import { AppError } from "@/lib/errors";

export interface OtpProvider {
  readonly name: "mock" | "whatsapp" | "sms";
  /** Returns `devCode` only for the mock provider, so the demo UI can display it. */
  send(phone: string, code: string): Promise<{ devCode?: string }>;
}

export class MockOtp implements OtpProvider {
  readonly name = "mock" as const;
  async send(phone: string, code: string) {
    if (!mockOtpAllowed()) throw new AppError("PROVIDER_ERROR", "OTP provider is not configured");
    console.info(`[otp:mock] ${phone} → ${code}`);
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
    if (id) await dispatchMessage(id, { code });
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
