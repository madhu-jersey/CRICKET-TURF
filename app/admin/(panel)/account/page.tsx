import { requireAdminPage } from "@/lib/auth/admin";
import { PageHeader } from "@/components/admin/shell";
import { AccountForms } from "@/components/admin/account-forms";
import { maskPhone } from "@/lib/auth/phone";
import { Alert } from "@/components/ui/field";
import { RecoveryCodesSection } from "@/components/admin/recovery-codes";
import { recoveryCodesLeft } from "@/lib/auth/admin-core";
import { getDb, schema } from "@/db/client";
import { eq } from "drizzle-orm";

export const metadata = { title: "My account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ force?: string }> }) {
  const { admin } = await requireAdminPage("STAFF", { allowMustChange: true });
  const { force } = await searchParams;
  const db = await getDb();
  const [me] = await db.select({ at: schema.adminUsers.recoveryCodesAt }).from(schema.adminUsers).where(eq(schema.adminUsers.id, admin.id));
  const left = await recoveryCodesLeft(admin.id);
  return (
    <>
      <PageHeader title="My account" />
      {(admin.mustChangePassword || force) && (
        <Alert tone="warn" className="mb-4">
          Please choose a new password before continuing.
        </Alert>
      )}
      <p className="mb-4 text-sm text-zinc-600">
        {admin.name} · {admin.email} · {admin.role.toLowerCase()} · login codes go to {admin.phone ? maskPhone(admin.phone) : <strong>no phone set</strong>}
      </p>
      <AccountForms email={admin.email} />
      <div className="mt-4">
        <RecoveryCodesSection left={left} generatedAt={me?.at ? me.at.toISOString() : null} />
      </div>
    </>
  );
}
