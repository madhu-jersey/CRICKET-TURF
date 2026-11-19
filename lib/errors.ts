import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { firstIssue } from "@/lib/validation";
import { reportError } from "@/lib/error-report";

export type ErrorCode =
  | "VALIDATION"
  | "SLOT_TAKEN"
  | "HOLD_EXPIRED"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "PHONE_NOT_VERIFIED"
  | "RATE_LIMITED"
  | "INVALID_SIGNATURE"
  | "NOT_ALLOWED"
  | "OTP_INVALID"
  | "OTP_EXPIRED"
  | "OTP_LOCKED"
  | "FRESH_OTP_REQUIRED"
  | "PROVIDER_ERROR"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  SLOT_TAKEN: 409,
  HOLD_EXPIRED: 410,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PHONE_NOT_VERIFIED: 401,
  RATE_LIMITED: 429,
  INVALID_SIGNATURE: 400,
  NOT_ALLOWED: 409,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_LOCKED: 429,
  FRESH_OTP_REQUIRED: 401,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
  }
  get status() {
    return STATUS[this.code];
  }
}

export const SLOT_TAKEN_MESSAGE = "This slot was just taken, please pick another.";

export function errorResponse(err: unknown, ctx: { method?: string; path?: string } = {}) {
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: { code: "VALIDATION", message: firstIssue(err) } }, { status: 400 });
  }
  console.error("[api] unexpected error", err);
  reportError(err, ctx); // optional Sentry, scrubbed (SEC-55)
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, { status: 500 });
}

/** Wraps a route handler so thrown AppErrors become JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      const req = args[0] instanceof Request ? args[0] : undefined;
      return errorResponse(e, req ? { method: req.method, path: new URL(req.url).pathname } : {});
    }
  };
}

/** Largest JSON body any public or admin endpoint accepts (our biggest real payload is < 4 KB). [SEC-19] */
export const MAX_JSON_BYTES = 32 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new AppError("VALIDATION", "Request is too large.");
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new AppError("VALIDATION", "Invalid JSON body");
  }
  if (text.length > MAX_JSON_BYTES) throw new AppError("VALIDATION", "Request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION", "Invalid JSON body");
  }
}
