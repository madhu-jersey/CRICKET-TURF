import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/lib/errors";
import { loginAdmin, logoutAdmin } from "@/lib/auth/admin";
import { clientIp } from "@/lib/ratelimit";

const body = z.object({
  email: z.string().trim().email("Enter a valid email").max(200),
  password: z.string().min(1, "Enter your password").max(200),
  trustDevice: z.boolean().optional(),
});

/** Step 1 of login. Either signs in (2FA off / trusted device) or returns a 2FA challenge. */
export const POST = handle(async (req: Request) => {
  const { email, password, trustDevice } = body.parse(await readJson(req));
  const r = await loginAdmin(email, password, clientIp(req), { trustDevice });
  if (r.done) return NextResponse.json({ ok: true, role: r.role, mustChangePassword: r.mustChangePassword });
  return NextResponse.json({ ok: true, twoFactor: true, challengeId: r.challengeId, maskedPhone: r.maskedPhone, devCode: r.devCode });
});

export const DELETE = handle(async () => {
  await logoutAdmin();
  return NextResponse.json({ ok: true });
});
