/**
 * WhatsApp message templates. The `params` order must match the template registered with Meta /
 * your BSP ({{1}}, {{2}}, …). `render` produces the preview text shown in the admin outbox.
 */
export type TemplateName =
  | "otp_code"
  | "booking_confirmed"
  | "booking_reminder"
  | "booking_cancelled"
  | "payment_failed_hold_expiring"
  | "admin_new_booking"
  | "admin_alert";

type Lang = "en" | "te";
type Def = { params: string[]; render: Record<Lang, (p: Record<string, string>) => string> };

export const TEMPLATES: Record<TemplateName, Def> = {
  otp_code: {
    params: ["code"],
    render: {
      en: (p) => `${p.code} is your Boundary Box Arena verification code. Valid for 5 minutes.`,
      te: (p) => `${p.code} మీ Boundary Box Arena ధృవీకరణ కోడ్. 5 నిమిషాల వరకు చెల్లుతుంది.`,
    },
  },
  booking_confirmed: {
    params: ["name", "sport", "court", "date", "time", "code", "advance", "balance", "map"],
    render: {
      en: (p) =>
        `Hi ${p.name}, your ${p.sport} booking is confirmed! ✅\nCourt: ${p.court}\nDate: ${p.date}\nTime: ${p.time}\nBooking code: ${p.code}\nAdvance paid: ${p.advance}\nBalance at venue: ${p.balance}\nDirections: ${p.map}`,
      te: (p) =>
        `నమస్తే ${p.name}, మీ ${p.sport} బుకింగ్ నిర్ధారించబడింది! ✅\nకోర్ట్: ${p.court}\nతేదీ: ${p.date}\nసమయం: ${p.time}\nబుకింగ్ కోడ్: ${p.code}\nఅడ్వాన్స్ చెల్లించారు: ${p.advance}\nవేదిక వద్ద బాకీ: ${p.balance}\nదారి: ${p.map}`,
    },
  },
  booking_reminder: {
    params: ["name", "sport", "court", "time", "code", "map"],
    render: {
      en: (p) => `Reminder: ${p.name}, your ${p.sport} slot on ${p.court} starts at ${p.time} today. Booking ${p.code}. See you at the ground! ${p.map}`,
      te: (p) => `రిమైండర్: ${p.name}, ${p.court}లో మీ ${p.sport} స్లాట్ ఈరోజు ${p.time}కి ప్రారంభం. బుకింగ్ ${p.code}. ${p.map}`,
    },
  },
  booking_cancelled: {
    params: ["name", "code", "date", "time", "refund"],
    render: {
      en: (p) => `Hi ${p.name}, booking ${p.code} for ${p.date}, ${p.time} has been cancelled. Refund: ${p.refund}. Refunds reach your account in 5–7 working days.`,
      te: (p) => `నమస్తే ${p.name}, ${p.date}, ${p.time} కోసం బుకింగ్ ${p.code} రద్దు చేయబడింది. రీఫండ్: ${p.refund}. 5–7 పని దినాల్లో మీ ఖాతాకు చేరుతుంది.`,
    },
  },
  payment_failed_hold_expiring: {
    params: ["name", "code", "minutes", "link"],
    render: {
      en: (p) => `Hi ${p.name}, your payment for booking ${p.code} didn't go through. Your slot is held for ${p.minutes} more minutes — retry here: ${p.link}`,
      te: (p) => `నమస్తే ${p.name}, బుకింగ్ ${p.code} చెల్లింపు విఫలమైంది. మీ స్లాట్ ఇంకా ${p.minutes} నిమిషాలు ఉంచబడుతుంది — ఇక్కడ మళ్లీ ప్రయత్నించండి: ${p.link}`,
    },
  },
  admin_alert: {
    params: ["text"],
    render: {
      en: (p) => `⚠️ Boundary Box Arena alert: ${p.text}`,
      te: (p) => `⚠️ Boundary Box Arena హెచ్చరిక: ${p.text}`,
    },
  },
  admin_new_booking: {
    params: ["code", "name", "phone", "court", "date", "time", "amount", "source"],
    render: {
      en: (p) => `New booking ${p.code} (${p.source}): ${p.name} ${p.phone} — ${p.court}, ${p.date} ${p.time}. Collected: ${p.amount}.`,
      te: (p) => `కొత్త బుకింగ్ ${p.code} (${p.source}): ${p.name} ${p.phone} — ${p.court}, ${p.date} ${p.time}. వసూలు: ${p.amount}.`,
    },
  },
};

export function renderTemplateUnsafe(name: TemplateName, params: Record<string, string>, lang: Lang = "en"): string {
  return TEMPLATES[name].render[lang](params);
}

/**
 * WhatsApp template parameters must be single-line text. User-supplied values (names) are
 * flattened, length-capped and stripped of link markers so they can't break the template or
 * smuggle a clickable link into a business message. [SEC-15]
 */
export function cleanParam(value: string, key?: string): string {
  let v = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (key === "name") v = v.replace(/https?:\/\//gi, "").replace(/\bwww\./gi, "").replace(/[<>{}]/g, "");
  return v.slice(0, key === "text" ? 200 : 120);
}

export function cleanParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, cleanParam(v, k)]));
}

export function renderTemplate(name: TemplateName, params: Record<string, string>, lang: "en" | "te" = "en"): string {
  return renderTemplateUnsafe(name, cleanParams(params), lang);
}

export function orderedParams(name: TemplateName, params: Record<string, string>): string[] {
  return TEMPLATES[name].params.map((k) => cleanParam(params[k] ?? "", k));
}
