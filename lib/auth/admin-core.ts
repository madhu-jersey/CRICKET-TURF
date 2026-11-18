/**
 * Admin account logic without cookies (testable): passwords, one-time codes for password reset and
 * two-factor login, staff management, session revocation. Route handlers add the cookies. [SEC-38][SEC-39]
 */
import "server-only";
import bcrypt from "bcryptjs";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { generateOtpCode } from "@/lib/otp";
import { hmacHex, safeEqual } from "@/lib/security";
import { getOtpProvider, SmsOtp } from "@/lib/providers/otp";
import { alertOwner } from "@/lib/alerts";
import { maskPhone } from "@/lib/auth/phone";
import { passwordProblem } from "@/lib/auth/passwords";
import type { AdminUser } from "@/db/schema";

export const CODE_TTL = { LOGIN: 5 * 60_000, RESET: 10 * 60_000 } as const;
export const CODE_MAX_ATTEMPTS = 5;
export type CodePurpose = keyof typeof CODE_TTL;

export function bcryptCost() {
  return Number(process.env.BCRYPT_COST) || 12;
}

/** 2FA for the dashboard: ADMIN_2FA_REQUIRED, defaulting to ON for live sites, OFF for dev/demo. */
export function admin2faRequired() {
  const v = env.str("ADMIN_2FA_REQUIRED");
  if (v === "true") return true;
  if (v === "false") return false;
  return env.isProduction && !env.demoMode;
}

const codeHash = (adminId: string, purpose: CodePurpose, code: string) => hmacHex(env.appSecret, `admin:${purpose}:${adminId}:${code}`);

/** Sends a code over the configured OTP channel (WhatsApp), falling back to SMS if that fails. Not counted against customer caps. */
async function deliverCode(phone: string, code: string): Promise<{ devCode?: string }> {
  try {
    return await getOtpProvider().send(phone, code);
  } catch (e) {
    const key = env.str("MSG91_AUTH_KEY");
    const tpl = env.str("MSG91_OTP_TEMPLATE_ID");
    if (!key || !tpl) throw e;
    return new SmsOtp(key, tpl).send(phone, code);
  }
}

/** Creates (and sends) a code for an admin. Older unused codes of the same purpose stop working. */
export async function issueAdminCode(admin: Pick<AdminUser, "id" | "phone">, purpose: CodePurpose, opts: { ip?: string; trustDevice?: boolean } = {}, now = new Date()) {
  if (!admin.phone) throw new AppError("NOT_ALLOWED", "No phone number is set for this account. Ask the owner to add one.");
  const db = await getDb();
  await db
    .update(schema.adminCodes)
    .set({ consumedAt: now })
    .where(and(eq(schema.adminCodes.adminId, admin.id), eq(schema.adminCodes.purpose, purpose), isNull(schema.adminCodes.consumedAt)));
  const code = generateOtpCode();
  const [row] = await db
    .insert(schema.adminCodes)
    .values({ adminId: admin.id, purpose, codeHash: codeHash(admin.id, purpose, code), expiresAt: new Date(now.getTime() + CODE_TTL[purpose]), trustDevice: !!opts.trustDevice, ip: opts.ip ?? null, createdAt: now })
    .returning({ id: schema.adminCodes.id });
  const { devCode } = await deliverCode(admin.phone, code);
  return { challengeId: row.id, maskedPhone: maskPhone(admin.phone), devCode };
}

/**
 * Checks a code. Bound to one admin and one purpose (a code for admin A can never log in admin B),
 * single use, expires, and locks after 5 tries. Attempts are counted atomically.
 */
export async function verifyAdminCode(where: { challengeId: string } | { adminId: string }, purpose: CodePurpose, code: string, now = new Date()) {
  const db = await getDb();
  const [rec] =
    "challengeId" in where
      ? await db.select().from(schema.adminCodes).where(and(eq(schema.adminCodes.id, where.challengeId), eq(schema.adminCodes.purpose, purpose)))
      : await db.select().from(schema.adminCodes).where(and(eq(schema.adminCodes.adminId, where.adminId), eq(schema.adminCodes.purpose, purpose))).orderBy(desc(schema.adminCodes.createdAt)).limit(1);
  const invalid = new AppError("OTP_INVALID", "That code is wrong or has expired. Request a new one.");
  if (!rec || rec.consumedAt || rec.expiresAt <= now) throw invalid;
  if (rec.attempts >= CODE_MAX_ATTEMPTS) throw new AppError("OTP_LOCKED", "Too many wrong codes. Request a new one.");
  const ok = /^\d{6}$/.test(code) && safeEqual(codeHash(rec.adminId, purpose, code), rec.codeHash);
  const updated = await db
    .update(schema.adminCodes)
    .set({ attempts: rec.attempts + 1, ...(ok ? { consumedAt: now } : {}) })
    .where(and(eq(schema.adminCodes.id, rec.id), eq(schema.adminCodes.attempts, rec.attempts), isNull(schema.adminCodes.consumedAt)))
    .returning({ id: schema.adminCodes.id });
  if (!updated.length || !ok) throw invalid;
  const [admin] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, rec.adminId));
  if (!admin || !admin.isActive) throw invalid;
  return { admin, trustDevice: rec.trustDevice };
}

/** Deletes sessions for an admin (all, or all except `keepSessionId`). */
export async function revokeSessions(adminId: string, keepSessionId?: string) {
  const db = await getDb();
  await db.delete(schema.adminSessions).where(keepSessionId ? and(eq(schema.adminSessions.adminId, adminId), ne(schema.adminSessions.id, keepSessionId)) : eq(schema.adminSessions.adminId, adminId));
}

async function setPassword(admin: AdminUser, newPassword: string, actor: string, action: string, now: Date, opts: { mustChange?: boolean; keepSessionId?: string } = {}) {
  const db = await getDb();
  await db
    .update(schema.adminUsers)
    .set({
      passwordHash: await bcrypt.hash(newPassword, bcryptCost()),
      mustChangePassword: !!opts.mustChange,
      passwordChangedAt: now,
      trustEpoch: admin.trustEpoch + 1, // every trusted 2FA device must log in with a code again
    })
    .where(eq(schema.adminUsers.id, admin.id));
  await revokeSessions(admin.id, opts.keepSessionId);
  await audit(db, { actor, action, entity: "AdminUser", entityId: admin.id, after: { email: admin.email, mustChange: !!opts.mustChange } });
  void alertOwner(`password_${admin.id}_${now.getTime()}`, `Password ${action === "admin.password_reset_by_owner" ? "reset by the owner" : "changed"} for ${admin.email}. If this wasn't expected, check the audit log.`, now);
}

/** Logged-in change: current password required; other sessions are signed out. */
export async function changePassword(adminId: string, current: string, next: string, keepSessionId: string, now = new Date()) {
  const db = await getDb();
  const [admin] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, adminId));
  if (!admin) throw new AppError("NOT_FOUND", "Account not found");
  if (!(await bcrypt.compare(current, admin.passwordHash))) throw new AppError("VALIDATION", "Your current password is wrong.");
  const problem = passwordProblem(next, admin.email);
  if (problem) throw new AppError("VALIDATION", problem);
  if (await bcrypt.compare(next, admin.passwordHash)) throw new AppError("VALIDATION", "Choose a password different from the current one.");
  await setPassword(admin, next, admin.email, "admin.password_change", now, { keepSessionId });
}

/** Forgot-password step 1. Always succeeds from the caller's view (no account enumeration). */
export async function requestPasswordReset(email: string, ip: string, now = new Date()) {
  const db = await getDb();
  const [admin] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email.trim().toLowerCase()));
  if (!admin || !admin.isActive || !admin.phone) return;
  await issueAdminCode(admin, "RESET", { ip }, now);
  await audit(db, { actor: "system", action: "admin.password_reset_requested", entity: "AdminUser", entityId: admin.id, after: { ip } });
}

/** Forgot-password step 2: code + new password. Signs out every session. */
export async function resetPasswordWithCode(email: string, code: string, next: string, now = new Date()) {
  const db = await getDb();
  const [admin] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email.trim().toLowerCase()));
  if (!admin) throw new AppError("OTP_INVALID", "That code is wrong or has expired. Request a new one.");
  await verifyAdminCode({ adminId: admin.id }, "RESET", code, now);
  const problem = passwordProblem(next, admin.email);
  if (problem) throw new AppError("VALIDATION", problem);
  await setPassword(admin, next, admin.email, "admin.password_reset", now);
}

// ── Staff management (OWNER only; enforced by the routes) ──

export async function createStaff(input: { email: string; name: string; phone: string; tempPassword: string }, actor: string) {
  const db = await getDb();
  const email = input.email.trim().toLowerCase();
  const problem = passwordProblem(input.tempPassword, email);
  if (problem) throw new AppError("VALIDATION", problem);
  const [exists] = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(eq(schema.adminUsers.email, email));
  if (exists) throw new AppError("VALIDATION", "An account with this email already exists.");
  const [u] = await db
    .insert(schema.adminUsers)
    .values({ email, name: input.name, phone: input.phone, role: "STAFF", passwordHash: await bcrypt.hash(input.tempPassword, bcryptCost()), mustChangePassword: true })
    .returning();
  await audit(db, { actor, action: "admin.staff_create", entity: "AdminUser", entityId: u.id, after: { email, name: input.name } });
  return u;
}

export async function manageStaff(id: string, action: { type: "reset_password"; tempPassword: string } | { type: "disable" } | { type: "enable" } | { type: "set_phone"; phone: string }, actor: string, now = new Date()) {
  const db = await getDb();
  const [u] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, id));
  if (!u || u.role !== "STAFF") throw new AppError("NOT_FOUND", "Staff account not found.");
  switch (action.type) {
    case "reset_password": {
      const problem = passwordProblem(action.tempPassword, u.email);
      if (problem) throw new AppError("VALIDATION", problem);
      await setPassword(u, action.tempPassword, actor, "admin.password_reset_by_owner", now, { mustChange: true });
      return;
    }
    case "disable":
      await db.update(schema.adminUsers).set({ isActive: false, trustEpoch: u.trustEpoch + 1 }).where(eq(schema.adminUsers.id, id));
      await revokeSessions(id);
      break;
    case "enable":
      await db.update(schema.adminUsers).set({ isActive: true }).where(eq(schema.adminUsers.id, id));
      break;
    case "set_phone":
      await db.update(schema.adminUsers).set({ phone: action.phone }).where(eq(schema.adminUsers.id, id));
      break;
  }
  await audit(db, { actor, action: `admin.staff_${action.type}`, entity: "AdminUser", entityId: id, after: { email: u.email } });
}
