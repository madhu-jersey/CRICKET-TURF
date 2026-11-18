import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/lib/errors";
import { verifyAdminLogin } from "@/lib/auth/admin";
import { clientIp } from "@/lib/ratelimit";

const body = z.object({ challengeId: z.string().min(1).max(64), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });

/** Step 2 of login: the code sent to the admin's phone. [SEC-39] */
export const POST = handle(async (req: Request) => {
  const { challengeId, code } = body.parse(await readJson(req));
  const r = await verifyAdminLogin(challengeId, code, clientIp(req));
  return NextResponse.json({ ok: true, role: r.role, mustChangePassword: r.mustChangePassword });
});
