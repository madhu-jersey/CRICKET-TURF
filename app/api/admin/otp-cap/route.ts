import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/booking/data";
import { audit } from "@/lib/audit";
import { istDateKey } from "@/lib/time";

/** Owner: "Raise today's cap" — adds to both OTP pools for the rest of today (IST). Audit-logged. [SEC-34] */
export const POST = adminRoute("OWNER", async (req, { admin }) => {
  const { amount } = z.object({ amount: z.coerce.number().int().min(1).max(10000) }).parse(await readJson(req));
  const db = await getDb();
  const s = await getSettings(db);
  const today = istDateKey(new Date());
  const boost = (s.otpCapBoostDate === today ? s.otpCapBoost : 0) + amount;
  await db.update(schema.settings).set({ otpCapBoost: boost, otpCapBoostDate: today, updatedAt: new Date() }).where(eq(schema.settings.id, 1));
  await audit(db, { actor: admin.email, action: "settings.otp_cap_raise", entity: "Settings", entityId: "1", before: { boost: s.otpCapBoostDate === today ? s.otpCapBoost : 0 }, after: { boost, date: today } });
  return NextResponse.json({ ok: true, boost });
});
