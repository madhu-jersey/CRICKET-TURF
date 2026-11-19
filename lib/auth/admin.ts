/**
 * Admin auth: bcrypt passwords, opaque session tokens (only their SHA-256 is stored),
 * httpOnly session cookie, per-session CSRF token (double-submit + Origin check), and two-factor
 * login: after a correct password a 6-digit code goes to the admin's phone and the session is only
 * created once that code is verified, unless this device is trusted for that admin. [SEC-39]
 */
import "server-only";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { randomToken, safeEqual, sha256Hex, signToken, verifyToken } from "@/lib/security";
import { hitRateLimit } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { admin2faRequired, bcryptCost, ensureRecoveryCodes, issueAdminCode, verifyAdminCode, verifyRecoveryLogin } from "@/lib/auth/admin-core";
import type { AdminRole, AdminUser } from "@/db/schema";

export { bcryptCost };
export const ADMIN_COOKIE = "bba_admin";
export const CSRF_COOKIE = "bba_csrf";
export const ADMIN_TRUST_COOKIE = "bba_admin_td";
const SESSION_TTL_MS = 12 * 3_600_000;
const ADMIN_TRUST_TTL_MS = 30 * 24 * 3_600_000;

export type AdminContext = {
  admin: Pick<AdminUser, "id" | "email" | "name" | "role" | "phone" | "mustChangePassword">;
  csrfToken: string;
  sessionId: string;
};

// Compared against when the email does not exist, so response timing does not reveal valid emails.
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("not-a-real-password", bcryptCost()));

async function checkLoginLimits(email: string, ip: string) {
  const okIp = await hitRateLimit(`admin-login-ip:${ip}`, 20, 15 * 60_000);
  const okEmail = await hitRateLimit(`admin-login:${email}`, 5, 15 * 60_000);
  if (!okIp || !okEmail) throw new AppError("RATE_LIMITED", "Too many login attempts. Try again in 15 minutes.");
}

/** Trusted 2FA device for one admin (signed, httpOnly, 30 days; revoked by bumping AdminUser.trustEpoch). */
function adminTrustValid(token: string | undefined, admin: Pick<AdminUser, "id" | "trustEpoch">) {
  const data = verifyToken<{ adminId: string; epoch: number; exp: number; purpose: string }>(token, env.appSecret);
  return !!data && data.purpose === "admin-trust" && data.adminId === admin.id && data.epoch === admin.trustEpoch;
}

async function createSession(user: AdminUser, ip: string, via: string) {
  const db = await getDb();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  await db.delete(schema.adminSessions).where(lt(schema.adminSessions.expiresAt, now));
  await db.insert(schema.adminSessions).values({ id: sha256Hex(token), adminId: user.id, csrfToken, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  await audit(db, { actor: user.email, action: "admin.login", entity: "AdminUser", entityId: user.id, after: { ip, via } });
  const jar = await cookies();
  const base = { sameSite: "lax" as const, secure: env.isProduction, path: "/", maxAge: SESSION_TTL_MS / 1000 };
  jar.set(ADMIN_COOKIE, token, { ...base, httpOnly: true });
  jar.set(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
}

export type LoginResult = { done: true; role: AdminRole; mustChangePassword: boolean } | { done: false; challengeId: string; maskedPhone: string; devCode?: string };

/** Step 1: password. Returns a session (2FA off or trusted device) or a 2FA challenge. */
export async function loginAdmin(email: string, password: string, ip: string, opts: { trustDevice?: boolean } = {}): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  await checkLoginLimits(normalized, ip);
  const db = await getDb();
  const [user] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, normalized));
  const valid = await bcrypt.compare(password, user?.passwordHash ?? getDummyHash());
  if (!user || !valid || !user.isActive) throw new AppError("UNAUTHORIZED", "Incorrect email or password.");

  const trusted = adminTrustValid((await cookies()).get(ADMIN_TRUST_COOKIE)?.value, user);
  if (!admin2faRequired() || trusted) {
    await createSession(user, ip, trusted ? "trusted-device" : "password");
    return { done: true, role: user.role, mustChangePassword: user.mustChangePassword };
  }
  // Admin codes go straight to the provider: they never count against the customer OTP caps.
  const c = await issueAdminCode(user, "LOGIN", { ip, trustDevice: opts.trustDevice });
  return { done: false, challengeId: c.challengeId, maskedPhone: c.maskedPhone, devCode: c.devCode };
}

/**
 * Step 2: the phone code (or a recovery code). Creates the session and, if asked, trusts this device for
 * 30 days. A recovery-code login never trusts the device. On the first two-step login the admin's
 * recovery codes are made and returned once. [SEC-39][SEC-41]
 */
export async function verifyAdminLogin(challengeId: string, proof: { code: string } | { recoveryCode: string }, ip: string) {
  if (!(await hitRateLimit(`admin-2fa-ip:${ip}`, 30, 15 * 60_000))) throw new AppError("RATE_LIMITED", "Too many attempts. Try again in 15 minutes.");
  const viaRecovery = "recoveryCode" in proof;
  const { admin, trustDevice } = viaRecovery
    ? { ...(await verifyRecoveryLogin(challengeId, proof.recoveryCode)), trustDevice: false }
    : await verifyAdminCode({ challengeId }, "LOGIN", proof.code);
  await createSession(admin, ip, viaRecovery ? "recovery-code" : "2fa");
  const recoveryCodes = viaRecovery ? undefined : await ensureRecoveryCodes(admin);
  if (trustDevice) {
    (await cookies()).set(ADMIN_TRUST_COOKIE, signToken({ adminId: admin.id, epoch: admin.trustEpoch, exp: Date.now() + ADMIN_TRUST_TTL_MS, purpose: "admin-trust" }, env.appSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      path: "/",
      maxAge: ADMIN_TRUST_TTL_MS / 1000,
    });
  }
  return { role: admin.role, mustChangePassword: admin.mustChangePassword, recoveryCodes };
}

export async function getAdminSession(): Promise<AdminContext | null> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const sessionId = sha256Hex(token);
  const [row] = await db
    .select({
      id: schema.adminUsers.id,
      email: schema.adminUsers.email,
      name: schema.adminUsers.name,
      role: schema.adminUsers.role,
      phone: schema.adminUsers.phone,
      mustChangePassword: schema.adminUsers.mustChangePassword,
      isActive: schema.adminUsers.isActive,
      csrfToken: schema.adminSessions.csrfToken,
    })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminSessions.adminId, schema.adminUsers.id))
    .where(and(eq(schema.adminSessions.id, sessionId), gt(schema.adminSessions.expiresAt, new Date())));
  if (!row || !row.isActive) return null;
  const { csrfToken, isActive: _active, ...admin } = row;
  return { admin, csrfToken, sessionId };
}

export async function logoutAdmin() {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, sha256Hex(token)));
  }
  jar.delete(ADMIN_COOKIE);
  jar.delete(CSRF_COOKIE);
}

const rank: Record<AdminRole, number> = { STAFF: 1, OWNER: 2 };

/** For server components / pages. Accounts that must change their password only see /admin/account. */
export async function requireAdminPage(minRole: AdminRole = "STAFF", opts: { allowMustChange?: boolean } = {}): Promise<AdminContext> {
  const s = await getAdminSession();
  if (!s) redirect("/admin/login");
  if (s.admin.mustChangePassword && !opts.allowMustChange) redirect("/admin/account?force=1");
  if (rank[s.admin.role] < rank[minRole]) redirect("/admin/bookings?denied=1");
  return s;
}

/** For /api/admin/* route handlers. Checks session, role, forced password change and (for writes) CSRF + Origin. */
export async function requireAdminApi(req: Request, minRole: AdminRole = "STAFF", opts: { allowMustChange?: boolean } = {}): Promise<AdminContext> {
  const s = await getAdminSession();
  if (!s) throw new AppError("UNAUTHORIZED", "Please sign in again.");
  if (s.admin.mustChangePassword && !opts.allowMustChange) throw new AppError("FORBIDDEN", "Change your password first.");
  if (rank[s.admin.role] < rank[minRole]) throw new AppError("FORBIDDEN", "Only the owner can do that.");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const header = req.headers.get("x-csrf-token") ?? "";
    if (!safeEqual(header, s.csrfToken)) throw new AppError("FORBIDDEN", "Security check failed. Refresh the page and try again.");
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
  return s;
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, bcryptCost());
}
