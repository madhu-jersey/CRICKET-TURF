import { requireAdminPage } from "@/lib/auth/admin";
import { AdminShell } from "@/components/admin/shell";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  // Pages enforce their own role and the forced password change; the shell itself may render for both.
  const { admin } = await requireAdminPage("STAFF", { allowMustChange: true });
  return (
    <AdminShell name={admin.name} email={admin.email} role={admin.role}>
      {children}
    </AdminShell>
  );
}
