/**
 * WhatsApp messaging adapters, selected by MESSAGING_PROVIDER=mock|meta|bsp.
 * Adapters only deliver; queueing, opt-in checks, retries and logging live in lib/messaging.
 */
import "server-only";
import { env } from "@/lib/env";
import { maskForLog } from "@/lib/security";
import { orderedParams, type TemplateName } from "@/lib/messaging/templates";

export type OutgoingMessage = {
  to: string; // E.164, e.g. +919876543210
  template: TemplateName;
  language: "en" | "te";
  params: Record<string, string>;
  text: string; // rendered preview text
};

export interface MessagingProvider {
  readonly name: "mock" | "meta" | "bsp";
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string; mocked?: boolean }>;
}

export class MockProvider implements MessagingProvider {
  readonly name = "mock" as const;
  /** Set to make the next N sends fail (used by tests to exercise retries). */
  failNext = 0;
  async send(msg: OutgoingMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Mock provider simulated failure");
    }
    // Masked number, no message body (which can contain an OTP code). [SEC-18]
    if (process.env.NODE_ENV !== "test") console.info(`[whatsapp:mock] → ${maskForLog(msg.to)} [${msg.template}]`);
    return { providerMessageId: `mock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, mocked: true };
  }
}

/** WhatsApp Cloud API (graph.facebook.com) template messages. */
export class MetaCloudProvider implements MessagingProvider {
  readonly name = "meta" as const;
  constructor(private token: string, private phoneNumberId: string, private apiVersion = "v21.0") {
    if (!token || !phoneNumberId) throw new Error("META_WA_TOKEN and META_WA_PHONE_NUMBER_ID are required when MESSAGING_PROVIDER=meta");
  }
  async send(msg: OutgoingMessage) {
    const params = orderedParams(msg.template, msg.params);
    const components: unknown[] = [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }];
    // Authentication (OTP) templates require the code again on the copy-code button.
    if (msg.template === "otp_code") components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: params[0] }] });
    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to.replace(/^\+/, ""),
        type: "template",
        template: { name: msg.template, language: { code: msg.language === "te" ? "te" : "en" }, components },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok || !json.messages?.[0]?.id) throw new Error(json.error?.message ?? `WhatsApp Cloud API error ${res.status}`);
    return { providerMessageId: json.messages[0].id };
  }
}

/**
 * Generic BSP adapter (Interakt / AiSensy / Gupshup style). Posts
 * { phone, countryCode, template: { name, languageCode, bodyValues } } with an API key header.
 * Adjust `buildBody` to match your BSP's exact schema.
 */
export class GenericBspProvider implements MessagingProvider {
  readonly name = "bsp" as const;
  constructor(private url: string, private apiKey: string, private authHeader = "Authorization", private authPrefix = "Basic ") {
    if (!url || !apiKey) throw new Error("BSP_API_URL and BSP_API_KEY are required when MESSAGING_PROVIDER=bsp");
  }
  buildBody(msg: OutgoingMessage) {
    return {
      countryCode: "+91",
      phoneNumber: msg.to.replace(/^\+91/, ""),
      type: "Template",
      template: { name: msg.template, languageCode: msg.language, bodyValues: orderedParams(msg.template, msg.params) },
    };
  }
  async send(msg: OutgoingMessage) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [this.authHeader]: `${this.authPrefix}${this.apiKey}` },
      body: JSON.stringify(this.buildBody(msg)),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; result?: boolean; message?: string };
    if (!res.ok || json.result === false) throw new Error(json.message ?? `BSP error ${res.status}`);
    return { providerMessageId: json.id ?? json.messageId ?? `bsp_${Date.now()}` };
  }
}

let cached: MessagingProvider | undefined;
let override: MessagingProvider | undefined;

export function getMessagingProvider(): MessagingProvider {
  if (override) return override;
  if (cached) return cached;
  switch (env.messagingProvider) {
    case "meta":
      cached = new MetaCloudProvider(env.str("META_WA_TOKEN"), env.str("META_WA_PHONE_NUMBER_ID"), env.str("META_WA_API_VERSION", "v21.0"));
      break;
    case "bsp":
      cached = new GenericBspProvider(env.str("BSP_API_URL"), env.str("BSP_API_KEY"), env.str("BSP_AUTH_HEADER", "Authorization"), env.str("BSP_AUTH_PREFIX", "Basic "));
      break;
    default:
      cached = new MockProvider();
  }
  return cached;
}

export function setMessagingProviderOverride(p: MessagingProvider | undefined) {
  override = p;
}
