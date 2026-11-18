import { requireAdminPage } from "@/lib/auth/admin";
import { getSettings } from "@/lib/booking/data";
import { PageHeader } from "@/components/admin/shell";
import { SettingsForm } from "@/components/admin/settings-form";
import { env } from "@/lib/env";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdminPage("OWNER");
  const s = await getSettings();
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsForm
        initial={{
          advanceType: s.advanceType,
          advanceValue: String(s.advanceValue),
          holdMinutes: String(s.holdMinutes),
          cancellationCutoffHours: String(s.cancellationCutoffHours),
          refundPercentBeforeCutoff: String(s.refundPercentBeforeCutoff),
          maxDaysAhead: String(s.maxDaysAhead),
          newCustomerDiscountPercent: String(s.newCustomerDiscountPercent),
          maxActiveBookingsPerPhone: String(s.maxActiveBookingsPerPhone),
          maxBookingsPerPhonePerDay: String(s.maxBookingsPerPhonePerDay),
          noShowBlockThreshold: String(s.noShowBlockThreshold),
          otpDailyCap: String(s.otpDailyCap),
          ownerAlertPhone: s.ownerAlertPhone?.replace(/^\+91/, "") ?? "",
          businessName: s.businessName,
          address: s.address,
          mapLink: s.mapLink,
          phone: s.phone.replace(/^\+91/, ""),
        }}
        providers={{ payment: env.paymentProvider, messaging: env.messagingProvider, otp: env.otpProvider, demo: env.demoMode }}
      />
    </>
  );
}
