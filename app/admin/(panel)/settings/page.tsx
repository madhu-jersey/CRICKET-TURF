import { requireAdminPage } from "@/lib/auth/admin";
import { getSettings } from "@/lib/booking/data";
import { PageHeader } from "@/components/admin/shell";
import { SettingsForm } from "@/components/admin/settings-form";
import { SETTINGS_FIELDS } from "@/lib/admin/settings-fields";
import { otpCapUsage } from "@/lib/otp-service";
import { env } from "@/lib/env";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdminPage("OWNER");
  const [s, otpToday] = await Promise.all([getSettings(), otpCapUsage()]);
  const initial = Object.fromEntries(
    SETTINGS_FIELDS.map((k) => {
      const v = s[k as keyof typeof s];
      if (k === "ownerAlertPhone" || k === "phone") return [k, String(v ?? "").replace(/^\+91/, "")];
      return [k, String(v ?? "")];
    }),
  ) as Record<(typeof SETTINGS_FIELDS)[number], string>;
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsForm initial={initial} otpToday={otpToday} providers={{ payment: env.paymentProvider, messaging: env.messagingProvider, otp: env.otpProvider, demo: env.demoMode }} />
    </>
  );
}
