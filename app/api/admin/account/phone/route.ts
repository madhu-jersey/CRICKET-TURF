import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { phoneSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

/** Set your own phone (used for login codes and password reset). Needs the current password. */
export const PUT = adminRoute("STAFF", async (req, { admin }) => {
  const b = z.object({ phone: phoneSchema, currentPassword: z.string().min(1).max(200) }).parse(await readJson(req));
  const db = await getDb();
  const [u] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, admin.id));
  if (!u || !(await bcrypt.compare(b.currentPassword, u.passwordHash))) throw new AppError("VALIDATION", "Your current password is wrong.");
  await db.update(schema.adminUsers).set({ phone: b.phone, trustEpoch: u.trustEpoch + 1 }).where(eq(schema.adminUsers.id, admin.id));
  await audit(db, { actor: admin.email, action: "admin.phone_change", entity: "AdminUser", entityId: admin.id, before: { phone: u.phone }, after: { phone: b.phone } });
  return NextResponse.json({ ok: true });
});
