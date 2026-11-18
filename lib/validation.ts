import { z } from "zod";

/** Indian mobile: 10 digits starting 6-9. Accepts "+91", "91", "0" prefixes and spaces/dashes. */
export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+?91(?=\d{10}$)/, "").replace(/^0(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    const n = normalizeIndianPhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a valid 10-digit Indian mobile number" });
      return z.NEVER;
    }
    return n;
  });

/** Strips control chars and angle brackets, collapses whitespace. */
export function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F<>]/g, "").replace(/\s+/g, " ").trim();
}

export const nameSchema = z
  .string()
  .transform(sanitizeText)
  .pipe(z.string().min(2, "Name must be at least 2 characters").max(50, "Name must be at most 50 characters"));

export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Invalid time");
export const closeTimeSchema = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "Invalid time");
export const idSchema = z.string().min(1).max(64);
export const bookingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,5}-[A-Z0-9]{4,8}$/, "Invalid booking code");

export const otpSendSchema = z.union([
  z.object({ phone: phoneSchema }),
  z.object({ bookingCode: bookingCodeSchema }),
]);
export const otpVerifySchema = z.object({
  phone: phoneSchema.optional(),
  bookingCode: bookingCodeSchema.optional(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const createBookingSchema = z.object({
  courtId: idSchema,
  date: dateKeySchema,
  times: z.array(timeSchema).min(1).max(8),
  name: nameSchema,
  whatsappOptIn: z.boolean(),
  acceptTerms: z.literal(true, { message: "Please accept the terms" }),
  idempotencyKey: z.string().min(8).max(100),
});

export const paymentVerifySchema = z.object({
  orderId: z.string().min(1).max(100),
  paymentId: z.string().min(1).max(100),
  signature: z.string().min(1).max(200),
});

export const walkInSchema = z.object({
  courtId: idSchema,
  date: dateKeySchema,
  times: z.array(timeSchema).min(1).max(12),
  name: nameSchema,
  phone: phoneSchema,
  whatsappOptIn: z.boolean().default(false),
  source: z.enum(["WALK_IN", "PHONE"]),
  amountReceived: z.coerce.number().int().min(0).max(1_000_000),
  paymentMode: z.enum(["CASH", "UPI", "CARD"]),
  notes: z.string().max(300).transform(sanitizeText).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type WalkInInput = z.infer<typeof walkInSchema>;

export function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}
