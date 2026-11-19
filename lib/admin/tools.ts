/**
 * Owner account tools for live sites, used by scripts/admin.ts (npm run admin:*). Kept free of
 * "server-only" imports so a plain Node CLI can load it. [SEC-53]
 */
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { passwordProblem } from "@/lib/auth/passwords";
import { normalizeIndianPhone } from "@/lib/validation";
import { randomToken } from "@/lib/security";
import { audit } from "@/lib/audit";

export const DEMO_ADMIN_EMAILS = ["owner@demo.com", "staff@demo.com"];
const cost = () => Number(process.env.BCRYPT_COST) || 12;

export class ToolError extends Error {}

/** Creates an OWNER. Refuses if an active OWNER exists, unless `force`. */
export async function createOwner(input: { email: string; name: string; phone: string; password: string; force?: boolean }, actor = "cli") {
  const db = await getDb();
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ToolError("Enter a valid email address.");
  const name = input.name.trim();
  if (name.length < 2 || name.length > 50) throw new ToolError("Name must be 2–50 characters.");
  const phone = normalizeIndianPhone(input.phone);
  if (!phone) throw new ToolError("Phone must be an Indian mobile number, e.g. +919812345678.");
  const problem = passwordProblem(input.password, email);
  if (problem) throw new ToolError(problem);
  const owners = await db.select({ email: schema.adminUsers.email }).from(schema.adminUsers).where(and(eq(schema.adminUsers.role, "OWNER"), eq(schema.adminUsers.isActive, true)));
  if (owners.length && !input.force) throw new ToolError(`An active owner already exists (${owners.map((o) => o.email).join(", ")}). Use --force to add another.`);
  const [exists] = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(eq(schema.adminUsers.email, email));
  if (exists) throw new ToolError("An account with this email already exists.");
  const [u] = await db
    .insert(schema.adminUsers)
    .values({ email, name, phone, role: "OWNER", passwordHash: await bcrypt.hash(input.password, cost()), passwordChangedAt: new Date() })
    .returning({ id: schema.adminUsers.id, email: schema.adminUsers.email });
  await audit(db, { actor, action: "admin.owner_create", entity: "AdminUser", entityId: u.id, after: { email, name } });
  return u;
}

/** Deactivates the demo accounts and signs them out. Returns the emails that were active. */
export async function removeDemoAdmins(actor = "cli") {
  const db = await getDb();
  const rows = await db
    .update(schema.adminUsers)
    .set({ isActive: false })
    .where(and(inArray(schema.adminUsers.email, DEMO_ADMIN_EMAILS), eq(schema.adminUsers.isActive, true)))
    .returning({ id: schema.adminUsers.id, email: schema.adminUsers.email });
  for (const r of rows) {
    await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminId, r.id));
    await audit(db, { actor, action: "admin.demo_disabled", entity: "AdminUser", entityId: r.id, after: { email: r.email } });
  }
  return rows.map((r) => r.email);
}

/** A temporary password that passes the password rules. */
export function temporaryPassword() {
  for (;;) {
    const pw = `Tmp-${randomToken(12)}`;
    if (!passwordProblem(pw, "x@x.x")) return pw;
  }
}

/**
 * Locked-out admin: sets a temporary password (must be changed at next login), signs out every
 * session, revokes every trusted device (trustEpoch + 1) and deletes the recovery codes (a new set
 * is made at the next two-step login). Optionally sets a new phone for login codes.
 */
export async function recoverAdmin(input: { email: string; phone?: string }, actor = "cli") {
  const db = await getDb();
  const email = input.email.trim().toLowerCase();
  const [u] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email));
  if (!u) throw new ToolError("No admin account with that email.");
  let phone = u.phone;
  if (input.phone) {
    phone = normalizeIndianPhone(input.phone);
    if (!phone) throw new ToolError("Phone must be an Indian mobile number, e.g. +919812345678.");
  }
  const temp = temporaryPassword();
  const now = new Date();
  await db
    .update(schema.adminUsers)
    .set({ passwordHash: await bcrypt.hash(temp, cost()), mustChangePassword: true, trustEpoch: u.trustEpoch + 1, passwordChangedAt: now, recoveryCodesAt: null, isActive: true, phone })
    .where(eq(schema.adminUsers.id, u.id));
  await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminId, u.id));
  await db.delete(schema.adminRecoveryCodes).where(eq(schema.adminRecoveryCodes.adminId, u.id));
  await audit(db, { actor, action: "admin.recover", entity: "AdminUser", entityId: u.id, after: { email, phoneChanged: phone !== u.phone } });
  return { email, temporaryPassword: temp, phone };
}
