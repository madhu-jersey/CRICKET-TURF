import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { AppError, readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { getBookingById, netPaid } from "@/lib/booking/data";
import { cancelBooking, markBalancePaid, notifyConfirmed, refundCancelledBooking, setBookingOutcome } from "@/lib/booking/service";
import { getDb, schema } from "@/db/client";
import { enforceRateLimit } from "@/lib/ratelimit";

type P = { id: string };

export const GET = adminRoute<P>("STAFF", async (_req, _ctx, { id }) => {
  const d = await getBookingById(id);
  if (!d) throw new AppError("NOT_FOUND", "Booking not found");
  const db = await getDb();
  const messages = await db.select().from(schema.messageLogs).where(eq(schema.messageLogs.bookingId, id)).orderBy(desc(schema.messageLogs.createdAt));
  return NextResponse.json({ ...d, paid: netPaid(d.payments), messages });
});

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("balance_paid"), mode: z.enum(["CASH", "UPI", "CARD"]) }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("no_show") }),
  z.object({ action: z.literal("resend") }),
  z.object({ action: z.literal("cancel"), refundMode: z.enum(["FULL", "PARTIAL", "NONE"]), amount: z.coerce.number().int().min(0).optional(), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("refund"), amount: z.coerce.number().int().min(1) }),
]);

export const POST = adminRoute<P>("STAFF", async (req, { admin }, { id }) => {
  const a = action.parse(await readJson(req));
  const actor = admin.email;
  switch (a.action) {
    case "balance_paid":
      await markBalancePaid(id, a.mode, actor);
      break;
    case "complete":
      await setBookingOutcome(id, "COMPLETED", actor);
      break;
    case "no_show":
      await setBookingOutcome(id, "NO_SHOW", actor);
      break;
    case "resend": {
      await enforceRateLimit(`resend:${id}`, 3, 60 * 60_000, "This confirmation was resent recently. Try again later.");
      const d = await getBookingById(id);
      if (!d || d.booking.status !== "CONFIRMED") throw new AppError("NOT_ALLOWED", "Only confirmed bookings can be resent.");
      if (!d.customer.whatsappOptIn) throw new AppError("NOT_ALLOWED", "This customer hasn't opted in to WhatsApp messages.");
      notifyConfirmed(id, { resend: true });
      break;
    }
    case "cancel": {
      // Staff can cancel, but giving money back is the owner's decision. [SEC-14]
      if (a.refundMode !== "NONE" && admin.role !== "OWNER") throw new AppError("FORBIDDEN", "Only the owner can cancel with a refund.");
      const r = await cancelBooking({
        bookingId: id,
        actor,
        by: "ADMIN",
        reason: a.reason,
        refund: a.refundMode === "PARTIAL" ? { mode: "PARTIAL", amount: a.amount ?? 0 } : { mode: a.refundMode },
      });
      return NextResponse.json(r);
    }
    case "refund":
      if (admin.role !== "OWNER") throw new AppError("FORBIDDEN", "Only the owner can issue refunds.");
      return NextResponse.json({ refunded: await refundCancelledBooking(id, a.amount, actor) });
  }
  return NextResponse.json({ ok: true });
});
