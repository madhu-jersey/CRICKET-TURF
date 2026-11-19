/**
 * Admin account logic without cookies (testable): passwords, one-time codes for password reset and
 * two-factor login, staff management, session revocation. Route handlers add the cookies. [SEC-38][SEC-39]
 */
import "server-only";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { generateOtpCode } from "@/lib/otp";
import { hmacHex, safeEqual } from "@/lib/security";
import { deliverOtpCode } from "@/lib/providers/otp";
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

/** Sends a code over the configured OTP channel, falling back to SMS if that fails (SEC-46). Not counted against customer caps. */
async function deliverCode(phone: string, code: string): Promise<{ devCode?: string }> {
  return deliverOtpCode(phone, code);
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

// ── 2FA recovery codes [SEC-41] ──
// 10 single-use codes like "K7QD2-M9XPA" for when the admin's phone is lost. Only an HMAC (keyed with
// APP_SECRET, bound to the admin) is stored, so a database leak alone doesn't reveal usable codes.

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const recoveryHash = (adminId: string, code: string) => hmacHex(env.appSecret, `admin:recovery:${adminId}:${code}`);

/** Uppercases and strips spaces/dashes; null if it can't be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "");
  return c.length === 10 && [...c].every((ch) => RECOVERY_ALPHABET.includes(ch)) ? c : null;
}

function newRecoveryCode() {
  // randomInt is uniform (no modulo bias): 31^10 ≈ 2^49.5 possibilities per code.
  const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Makes a new set of 10 codes and deletes every older one. Returns the codes — the only time they're visible. */
export async function generateRecoveryCodes(adminId: string, actor: string, reason: "setup" | "regenerate", now = new Date()) {
  const db = await getDb();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.delete(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, adminId));
    await tx.insert(schema.adminRecoveryCodes).values(codes.map((c) => ({ adminId, codeHash: recoveryHash(adminId, normalizeRecoveryCode(c)!), createdAt: now })));
    await tx.update(schema.adminUsers).set({ recoveryCodesAt: now }).where(eq(schema.adminUsers.id, adminId));
    await audit(tx, { actor, action: reason === "setup" ? "admin.recovery_codes_created" : "admin.recovery_codes_regenerated", entity: "AdminUser", entityId: adminId, after: { count: codes.length } });
  });
  return codes;
}

/** If this admin has never had recovery codes (first two-step login), makes them now. */
export async function ensureRecoveryCodes(admin: Pick<AdminUser, "id" | "email" | "recoveryCodesAt">, now = new Date()) {
  if (admin.recoveryCodesAt) return undefined;
  const db = await getDb();
  // Claim the "first set" atomically so two parallel logins can't make two sets.
  const claimed = await db
    .update(schema.adminUsers)
    .set({ recoveryCodesAt: now })
    .where(and(eq(schema.adminUsers.id, admin.id), isNull(schema.adminUsers.recoveryCodesAt)))
    .returning({ id: schema.adminUsers.id });
  if (!claimed.length) return undefined;
  return generateRecoveryCodes(admin.id, admin.email, "setup", now);
}

export async function recoveryCodesLeft(adminId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.adminRecoveryCodes.id })
    .from(schema.adminRecoveryCodes)
    .where(and(eq(schema.adminRecoveryCodes.adminId, adminId), isNull(schema.adminRecoveryCodes.usedAt)));
  return rows.length;
}

/**
 * Login step 2 with a recovery code instead of the phone code. Needs the same password-checked
 * challenge (so a code alone can't log anyone in), counts against the challenge's 5 tries, and each
 * code works once. The owner is alerted every time one is used.
 */
export async function verifyRecoveryLogin(challengeId: string, input: string, now = new Date()) {
  const db = await getDb();
  const invalid = new AppError("OTP_INVALID", "That recovery code is wrong or already used.");
  const [rec] = await db.select().from(schema.adminCodes).where(and(eq(schema.adminCodes.id, challengeId), eq(schema.adminCodes.purpose, "LOGIN")));
  if (!rec || rec.consumedAt || rec.expiresAt <= now) throw new AppError("OTP_INVALID", "This sign-in has expired. Enter your password again.");
  if (rec.attempts >= CODE_MAX_ATTEMPTS) throw new AppError("OTP_LOCKED", "Too many wrong codes. Enter your password again.");
  const counted = await db
    .update(schema.adminCodes)
    .set({ attempts: rec.attempts + 1 })
    .where(and(eq(schema.adminCodes.id, rec.id), eq(schema.adminCodes.attempts, rec.attempts), isNull(schema.adminCodes.consumedAt)))
    .returning({ id: schema.adminCodes.id });
  if (!counted.length) throw invalid;
  const code = normalizeRecoveryCode(input);
  if (!code) throw invalid;
  const used = await db
    .update(schema.adminRecoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(schema.adminRecoveryCodes.adminId, rec.adminId), eq(schema.adminRecoveryCodes.codeHash, recoveryHash(rec.adminId, code)), isNull(schema.adminRecoveryCodes.usedAt)))
    .returning({ id: schema.adminRecoveryCodes.id });
  if (!used.length) throw invalid;
  await db.update(schema.adminCodes).set({ consumedAt: now }).where(eq(schema.adminCodes.id, rec.id));
  const [admin] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, rec.adminId));
  if (!admin || !admin.isActive) throw invalid;
  const left = await recoveryCodesLeft(admin.id);
  await audit(db, { actor: admin.email, action: "admin.recovery_code_used", entity: "AdminUser", entityId: admin.id, after: { left, ip: rec.ip } });
  void alertOwner(
    `recovery_${admin.id}_${now.getTime()}`,
    `A recovery code was used to sign in as ${admin.email} (${left} left). If this wasn't expected, disable the account and check the audit log.`,
    now,
  );
  return { admin, left };
}
