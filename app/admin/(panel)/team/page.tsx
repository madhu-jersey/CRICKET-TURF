import { asc } from "drizzle-orm";
import { requireAdminPage } from "@/lib/auth/admin";
import { getDb, schema } from "@/db/client";
import { PageHeader } from "@/components/admin/shell";
import { TeamManager } from "@/components/admin/team-manager";
import { maskPhone } from "@/lib/auth/phone";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  await requireAdminPage("OWNER");
  const db = await getDb();
  const users = await db.select().from(schema.adminUsers).orderBy(asc(schema.adminUsers.createdAt));
  return (
    <>
      <PageHeader title="Team" />
      <TeamManager
        users={users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive, phone: u.phone ? maskPhone(u.phone) : null, mustChangePassword: u.mustChangePassword }))}
      />
    </>
  );
}
