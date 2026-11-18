/**
 * Go-live safety checks. In production with DEMO_MODE=false the server refuses to start if the
 * site is still configured like a demo. [SEC-03]
 */
import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";

export const DEMO_ADMIN_EMAILS = ["owner@demo.com", "staff@demo.com"];
export const DEMO_ADMIN_PASSWORD = "Demo@1234";

export type CheckEnv = Record<string, string | undefined>;

/** Pure config checks (unit-tested). Returns a list of problems; empty = safe. */
export function configProblems(e: CheckEnv): string[] {
  const live = e.NODE_ENV === "production" && (e.DEMO_MODE ?? "true").trim() === "false";
  if (!live) return [];
  const p: string[] = [];
  if ((e.APP_SECRET ?? "").length < 32) p.push("APP_SECRET must be a random string of 32+ characters");
  if (!e.CRON_SECRET || e.CRON_SECRET.length < 16) p.push("CRON_SECRET must be set (16+ characters)");
  if (!e.DATABASE_URL) p.push("DATABASE_URL must point to a real Postgres database");
  if (e.PAYMENT_PROVIDER !== "razorpay") p.push("PAYMENT_PROVIDER must be razorpay (the mock checkout is free to use)");
  else if (!e.RAZORPAY_KEY_ID || !e.RAZORPAY_KEY_SECRET || !e.RAZORPAY_WEBHOOK_SECRET) p.push("RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET must be set");
  if (!e.OTP_PROVIDER || e.OTP_PROVIDER === "mock") p.push("OTP_PROVIDER must be whatsapp or sms (the mock shows codes on screen)");
  if (!e.NEXT_PUBLIC_SITE_URL?.startsWith("https://")) p.push("NEXT_PUBLIC_SITE_URL must be the https:// address of the site");
  return p;
}

/** DB check: no admin account still accepts the published demo password. */
export async function demoAdminProblems(): Promise<string[]> {
  const { getDb, schema } = await import("@/db/client");
  const db = await getDb();
  const rows = await db.select().from(schema.adminUsers).where(inArray(schema.adminUsers.email, DEMO_ADMIN_EMAILS));
  const p: string[] = [];
  for (const r of rows) {
    if (r.isActive && (await bcrypt.compare(DEMO_ADMIN_PASSWORD, r.passwordHash))) p.push(`Demo admin ${r.email} still has the demo password — delete it or change the password`);
  }
  return p;
}

export async function runStartupChecks(e: CheckEnv = process.env) {
  const live = e.NODE_ENV === "production" && (e.DEMO_MODE ?? "true").trim() === "false";
  if (!live) return;
  const problems = configProblems(e);
  if (!problems.length) problems.push(...(await demoAdminProblems()));
  if (problems.length) {
    console.error("\n[startup] Refusing to run in production:\n - " + problems.join("\n - ") + "\n");
    process.exit(1);
  }
}
