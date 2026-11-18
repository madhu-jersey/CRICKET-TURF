import { requireAdminPage } from "@/lib/auth/admin";
import { AdminShell } from "@/components/admin/shell";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const { admin } = await requireAdminPage("STAFF");
  return (
    <AdminShell name={admin.name} email={admin.email} role={admin.role}>
      {children}
    </AdminShell>
  );
}
