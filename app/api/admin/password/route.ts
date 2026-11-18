import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { changePassword, requestPasswordReset, resetPasswordWithCode } from "@/lib/auth/admin-core";
import { clientIp, enforceRateLimit } from "@/lib/ratelimit";

/** Logged-in password change (allowed while a change is forced). Signs out every other session. [SEC-38] */
export const PUT = adminRoute(
  "STAFF",
  async (req, { admin, sessionId }) => {
    const { currentPassword, newPassword } = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).parse(await readJson(req));
    await enforceRateLimit(`admin-pw-change:${admin.id}`, 10, 60 * 60_000);
    await changePassword(admin.id, currentPassword, newPassword, sessionId);
    return NextResponse.json({ ok: true });
  },
  { allowMustChange: true },
);

const GENERIC = "If this account exists, a code has been sent to its registered phone.";

/** Forgot password, step 1: always the same answer (no account enumeration). */
export const POST = handle(async (req: Request) => {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).parse(await readJson(req));
  const ip = clientIp(req);
  await enforceRateLimit(`admin-reset-ip:${ip}`, 10, 60 * 60_000, "Too many reset requests. Try again later.");
  // Per-account limit is applied silently so the response never differs for real accounts.
  const { hitRateLimit } = await import("@/lib/ratelimit");
  if (await hitRateLimit(`admin-reset:${email}`, 3, 60 * 60_000)) {
    await requestPasswordReset(email, ip).catch((e) => console.warn("[admin] reset send failed", e instanceof Error ? e.message : e));
  }
  return NextResponse.json({ ok: true, message: GENERIC });
});

/** Forgot password, step 2: email + code + new password. Signs out every session. */
export const PATCH = handle(async (req: Request) => {
  const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), newPassword: z.string().min(1).max(200) }).parse(await readJson(req));
  await enforceRateLimit(`admin-reset-verify-ip:${clientIp(req)}`, 20, 60 * 60_000, "Too many attempts. Try again later.");
  await resetPasswordWithCode(b.email, b.code, b.newPassword);
  return NextResponse.json({ ok: true });
});
