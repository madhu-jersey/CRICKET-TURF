/**
 * Admin auth: bcrypt passwords, opaque session tokens (only their SHA-256 is stored),
 * httpOnly session cookie, and a per-session CSRF token checked on every mutating API call
 * (double-submit: readable `bba_csrf` cookie echoed in the `x-csrf-token` header) plus an Origin check.
 */
import "server-only";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { randomToken, safeEqual, sha256Hex } from "@/lib/security";
import { hitRateLimit } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import type { AdminRole, AdminUser } from "@/db/schema";

export const ADMIN_COOKIE = "bba_admin";
export const CSRF_COOKIE = "bba_csrf";
const SESSION_TTL_MS = 12 * 3_600_000;

export type AdminContext = { admin: Pick<AdminUser, "id" | "email" | "name" | "role">; csrfToken: string };

// Compared against when the email does not exist, so response timing does not reveal valid emails.
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("not-a-real-password", 10));

export async function loginAdmin(email: string, password: string, ip: string) {
  const normalized = email.trim().toLowerCase();
  const okIp = await hitRateLimit(`admin-login-ip:${ip}`, 20, 15 * 60_000);
  const okEmail = await hitRateLimit(`admin-login:${normalized}`, 5, 15 * 60_000);
  if (!okIp || !okEmail) throw new AppError("RATE_LIMITED", "Too many login attempts. Try again in 15 minutes.");
  const db = await getDb();
  const [user] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, normalized));
  const valid = await bcrypt.compare(password, user?.passwordHash ?? getDummyHash());
  if (!user || !valid || !user.isActive) throw new AppError("UNAUTHORIZED", "Incorrect email or password.");

  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  await db.delete(schema.adminSessions).where(lt(schema.adminSessions.expiresAt, now));
  await db.insert(schema.adminSessions).values({ id: sha256Hex(token), adminId: user.id, csrfToken, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  await audit(db, { actor: user.email, action: "admin.login", entity: "AdminUser", entityId: user.id, after: { ip } });

  const jar = await cookies();
  const base = { sameSite: "lax" as const, secure: env.isProduction, path: "/", maxAge: SESSION_TTL_MS / 1000 };
  jar.set(ADMIN_COOKIE, token, { ...base, httpOnly: true });
  jar.set(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
  return { role: user.role };
}

export async function getAdminSession(): Promise<AdminContext | null> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.adminUsers.id, email: schema.adminUsers.email, name: schema.adminUsers.name, role: schema.adminUsers.role, isActive: schema.adminUsers.isActive, csrfToken: schema.adminSessions.csrfToken })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminSessions.adminId, schema.adminUsers.id))
    .where(and(eq(schema.adminSessions.id, sha256Hex(token)), gt(schema.adminSessions.expiresAt, new Date())));
  if (!row || !row.isActive) return null;
  return { admin: { id: row.id, email: row.email, name: row.name, role: row.role }, csrfToken: row.csrfToken };
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

/** For server components / pages. */
export async function requireAdminPage(minRole: AdminRole = "STAFF"): Promise<AdminContext> {
  const s = await getAdminSession();
  if (!s) redirect("/admin/login");
  if (rank[s.admin.role] < rank[minRole]) redirect("/admin/bookings?denied=1");
  return s;
}

/** For /api/admin/* route handlers. Checks session, role and (for writes) CSRF + Origin. */
export async function requireAdminApi(req: Request, minRole: AdminRole = "STAFF"): Promise<AdminContext> {
  const s = await getAdminSession();
  if (!s) throw new AppError("UNAUTHORIZED", "Please sign in again.");
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
  return bcrypt.hash(pw, 10);
}
