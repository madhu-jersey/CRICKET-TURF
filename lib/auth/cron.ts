import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { safeEqual } from "@/lib/security";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a secret, crons are open only outside production. */
export function assertCron(req: Request) {
  const secret = env.cronSecret;
  if (!secret) {
    if (env.isProduction) throw new AppError("UNAUTHORIZED", "CRON_SECRET is not configured");
    return;
  }
  const header = req.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${secret}`)) throw new AppError("UNAUTHORIZED", "Unauthorized");
}
