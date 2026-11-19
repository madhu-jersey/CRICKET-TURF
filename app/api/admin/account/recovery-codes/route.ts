import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { generateRecoveryCodes } from "@/lib/auth/admin-core";

/** Make a new set of 10 recovery codes (old ones stop working). Needs the current password. [SEC-41] */
export const POST = adminRoute("STAFF", async (req, { admin }) => {
  const b = z.object({ currentPassword: z.string().min(1).max(200) }).parse(await readJson(req));
  const db = await getDb();
  const [u] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, admin.id));
  if (!u || !(await bcrypt.compare(b.currentPassword, u.passwordHash))) throw new AppError("VALIDATION", "Your current password is wrong.");
  const codes = await generateRecoveryCodes(admin.id, admin.email, "regenerate");
  return NextResponse.json({ ok: true, codes }, { headers: { "cache-control": "no-store" } });
});
