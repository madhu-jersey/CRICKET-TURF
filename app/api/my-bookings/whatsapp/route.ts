import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, handle, readJson } from "@/lib/errors";
import { getVerifiedPhone } from "@/lib/auth/phone";
import { getDb, schema } from "@/db/client";
import { audit } from "@/lib/audit";

/** Customer self-service WhatsApp opt-out / opt-in (verified phone only). [SEC-18] */
export const POST = handle(async (req: Request) => {
  const phone = await getVerifiedPhone();
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Verify your phone number first.");
  const { optIn } = z.object({ optIn: z.boolean() }).parse(await readJson(req));
  const db = await getDb();
  const now = new Date();
  const rows = await db.update(schema.customers).set({ whatsappOptIn: optIn, optInAt: optIn ? now : null }).where(eq(schema.customers.phone, phone)).returning({ id: schema.customers.id });
  if (rows[0]) await audit(db, { actor: "customer", action: optIn ? "customer.whatsapp_opt_in" : "customer.whatsapp_opt_out", entity: "Customer", entityId: rows[0].id });
  return NextResponse.json({ ok: true, optIn });
});

export const GET = handle(async () => {
  const phone = await getVerifiedPhone();
  if (!phone) throw new AppError("PHONE_NOT_VERIFIED", "Verify your phone number first.");
  const db = await getDb();
  const [c] = await db.select({ optIn: schema.customers.whatsappOptIn }).from(schema.customers).where(eq(schema.customers.phone, phone));
  return NextResponse.json({ optIn: c?.optIn ?? false });
});
