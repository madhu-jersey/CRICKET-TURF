import { NextResponse } from "next/server";
import { readJson } from "@/lib/errors";
import { adminRoute } from "@/lib/admin/route";
import { walkInSchema } from "@/lib/validation";
import { createAdminBooking } from "@/lib/booking/service";

export const POST = adminRoute("STAFF", async (req, { admin }) => {
  const input = walkInSchema.parse(await readJson(req));
  const b = await createAdminBooking(input, admin.email);
  return NextResponse.json({ id: b.id, bookingCode: b.bookingCode }, { status: 201 });
});
