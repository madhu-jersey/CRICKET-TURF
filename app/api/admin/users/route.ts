import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { createStaff, manageStaff } from "@/lib/auth/admin-core";
import { idSchema, nameSchema, phoneSchema } from "@/lib/validation";

/** OWNER: add a staff account (must change the temporary password at first login). [SEC-38] */
export const POST = adminRoute("OWNER", async (req, { admin }) => {
  const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: nameSchema, phone: phoneSchema, tempPassword: z.string().min(1).max(200) }).parse(await readJson(req));
  const u = await createStaff(b, admin.email);
  return NextResponse.json({ id: u.id }, { status: 201 });
});

const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reset_password"), tempPassword: z.string().min(1).max(200) }),
  z.object({ type: z.literal("disable") }),
  z.object({ type: z.literal("enable") }),
  z.object({ type: z.literal("set_phone"), phone: phoneSchema }),
]);

/** OWNER: reset a staff password, disable/enable, or set their phone. Owner accounts can't be changed here. */
export const PATCH = adminRoute("OWNER", async (req, { admin }) => {
  const b = z.object({ id: idSchema, action }).parse(await readJson(req));
  await manageStaff(b.id, b.action, admin.email);
  return NextResponse.json({ ok: true });
});
