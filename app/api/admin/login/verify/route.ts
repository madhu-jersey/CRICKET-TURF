import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/lib/errors";
import { verifyAdminLogin } from "@/lib/auth/admin";
import { clientIp } from "@/lib/ratelimit";

const body = z.union([
  z.object({ challengeId: z.string().min(1).max(64), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }),
  z.object({ challengeId: z.string().min(1).max(64), recoveryCode: z.string().trim().min(10, "Enter a recovery code like ABCDE-FGHJK").max(20) }),
]);

/** Step 2 of login: the code sent to the admin's phone, or one of their recovery codes. [SEC-39][SEC-41] */
export const POST = handle(async (req: Request) => {
  const b = body.parse(await readJson(req));
  const r = await verifyAdminLogin(b.challengeId, "code" in b ? { code: b.code } : { recoveryCode: b.recoveryCode }, clientIp(req));
  // recoveryCodes is only present on the first two-step login: shown once, never stored in plain text.
  return NextResponse.json({ ok: true, role: r.role, mustChangePassword: r.mustChangePassword, recoveryCodes: r.recoveryCodes });
});
