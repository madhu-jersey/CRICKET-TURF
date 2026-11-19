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
  if (!e.NEXT_PUBLIC_TURNSTILE_SITE_KEY || !e.TURNSTILE_SECRET_KEY) p.push("NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set (bot check on OTP sends)");
  return p;
}

/** Non-fatal warnings for a live site. */
export function configWarnings(e: CheckEnv): string[] {
  const live = e.NODE_ENV === "production" && (e.DEMO_MODE ?? "true").trim() === "false";
  if (!live) return [];
  const w: string[] = [];
  if ((e.ADMIN_2FA_REQUIRED ?? "").trim() === "false") w.push("ADMIN_2FA_REQUIRED=false — dashboard logins do not need a phone code");
  if (!(e.SENTRY_DSN ?? "").trim()) w.push("SENTRY_DSN is not set — server errors are only in the platform logs (no error tracking)");
  return w;
}

/**
 * DB check: every migration the code expects has been applied. Runs before anything else touches
 * the database, so a forgotten `npm run deploy:migrate` stops the deploy with the missing names
 * instead of failing later with "column does not exist". [SEC-52]
 */
export async function migrationProblems(): Promise<string[]> {
  const { getDb } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { missingMigrations } = await import("@/db/migration-list");
  const db = await getDb();
  let applied: string[];
  try {
    const rows = (await db.execute(sql`select "name" from "_migrations"`)) as unknown as { name: string }[] | { rows: { name: string }[] };
    applied = (Array.isArray(rows) ? rows : rows.rows).map((r) => String(r.name));
  } catch {
    applied = [];
  }
  const missing = missingMigrations(applied);
  return missing.length ? [`The database is missing migrations: ${missing.join(", ")}. Run "npm run deploy:migrate" against this database, then deploy again.`] : [];
}

/** DB check: no admin account still accepts the published demo password. */
export async function demoAdminProblems(): Promise<string[]> {
  const { getDb, schema } = await import("@/db/client");
  const db = await getDb();
  const rows = await db.select().from(schema.adminUsers).where(inArray(schema.adminUsers.email, DEMO_ADMIN_EMAILS));
  const p: string[] = [];
  const owners = await db.select().from(schema.adminUsers).where(inArray(schema.adminUsers.role, ["OWNER"]));
  if (!owners.some((o) => o.isActive && o.phone)) p.push("The OWNER account needs a phone number (for login codes and password reset)");
  for (const r of rows) {
    if (r.isActive && (await bcrypt.compare(DEMO_ADMIN_PASSWORD, r.passwordHash))) p.push(`Demo admin ${r.email} still has the demo password — delete it or change the password`);
  }
  return p;
}

export async function runStartupChecks(e: CheckEnv = process.env) {
  const live = e.NODE_ENV === "production" && (e.DEMO_MODE ?? "true").trim() === "false";
  if (!live) return;
  const problems = configProblems(e);
  if (!problems.length) problems.push(...(await migrationProblems()));
  if (!problems.length) problems.push(...(await demoAdminProblems()));
  for (const w of configWarnings(e)) console.warn(`[startup] WARNING: ${w}`);
  if (problems.length) {
    console.error("\n[startup] Refusing to run in production:\n - " + problems.join("\n - ") + "\n");
    process.exit(1);
  }
}
