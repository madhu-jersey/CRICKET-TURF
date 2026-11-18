import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getDb, schema } from "@/db/client";
import { idSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

const body = z.object({ id: idSchema, isBlocked: z.boolean().optional(), whatsappOptIn: z.boolean().optional(), revokeTrustedDevices: z.literal(true).optional() });

/** Owner: block/unblock a number for online booking, or record a WhatsApp opt-out/opt-in. [SEC-12][SEC-18] */
export const PATCH = adminRoute("OWNER", async (req, { admin }) => {
  const b = body.parse(await readJson(req));
  const db = await getDb();
  const [before] = await db.select().from(schema.customers).where(eq(schema.customers.id, b.id));
  if (!before) throw new AppError("NOT_FOUND", "Customer not found");
  const now = new Date();
  const set: Partial<typeof schema.customers.$inferInsert> = {};
  if (b.isBlocked !== undefined) Object.assign(set, b.isBlocked ? { isBlocked: true, blockedAt: now, blockedReason: `Blocked by ${admin.email}` } : { isBlocked: false, blockedAt: null, blockedReason: null });
  // Blocking or an explicit revoke signs the number out of every trusted device. [SEC-35]
  if (b.isBlocked || b.revokeTrustedDevices) Object.assign(set, { trustEpoch: before.trustEpoch + 1 });
  if (b.whatsappOptIn !== undefined) Object.assign(set, { whatsappOptIn: b.whatsappOptIn, optInAt: b.whatsappOptIn ? now : null });
  if (!Object.keys(set).length) return NextResponse.json({ ok: true });
  await db.update(schema.customers).set(set).where(eq(schema.customers.id, b.id));
  await audit(db, { actor: admin.email, action: "customer.update", entity: "Customer", entityId: b.id, before: { isBlocked: before.isBlocked, whatsappOptIn: before.whatsappOptIn }, after: set });
  return NextResponse.json({ ok: true });
});
