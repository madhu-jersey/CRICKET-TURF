import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { retryMessage } from "@/lib/messaging";
import { getDb, schema } from "@/db/client";
import { audit } from "@/lib/audit";

export const POST = adminRoute<{ id: string }>("OWNER", async (_req, { admin }, { id }) => {
  const ok = await retryMessage(id);
  if (!ok) throw new AppError("NOT_ALLOWED", "This message can't be resent (OTP codes expire).");
  const db = await getDb();
  const [m] = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.id, id));
  await audit(db, { actor: admin.email, action: "message.retry", entity: "MessageLog", entityId: id, after: { status: m?.status } });
  return NextResponse.json({ status: m?.status, error: m?.error });
});
