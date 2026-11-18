import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, readJson } from "@/lib/errors";
import { loginAdmin, logoutAdmin } from "@/lib/auth/admin";
import { clientIp } from "@/lib/ratelimit";

const body = z.object({ email: z.string().trim().email("Enter a valid email").max(200), password: z.string().min(1, "Enter your password").max(200) });

export const POST = handle(async (req: Request) => {
  const { email, password } = body.parse(await readJson(req));
  const r = await loginAdmin(email, password, clientIp(req));
  return NextResponse.json({ ok: true, role: r.role });
});

export const DELETE = handle(async () => {
  await logoutAdmin();
  return NextResponse.json({ ok: true });
});
