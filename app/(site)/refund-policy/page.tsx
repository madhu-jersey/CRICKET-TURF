import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";
import { getSettings } from "@/lib/booking/data";
import { siteConfig } from "@/config/site";
import { policyLines } from "@/lib/policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cancellation & refund policy", alternates: { canonical: "/refund-policy" } };

export default async function RefundPolicy() {
  const s = await getSettings();
  return (
    <LegalPage title="Cancellation & refunds" updated="November 2026">
      <p>This policy applies to slots booked online at {siteConfig.name}. It is shown before you pay and applies automatically when you cancel.</p>
      <h2>Advance payment</h2>
      <p>To confirm a slot you pay an advance online ({s.advanceType === "FIXED" ? `₹${s.advanceValue} per booking` : `${s.advanceValue}% of the booking total`}). The remaining balance is paid at the venue by cash or UPI before play.</p>
      <h2>Cancelling a booking</h2>
      <ul data-testid="policy-lines">
        <li>Cancel from your booking page or from <a href="/my-bookings">My bookings</a> after verifying your phone number.</li>
        {policyLines(s).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h2>Refund timelines</h2>
      <p>Refunds go back to the original payment method through our payment partner (Razorpay) and usually reach your account within 5–7 working days.</p>
      <h2>Cancellations by the venue</h2>
      <p>If we cancel your slot (rain making the turf unplayable, maintenance, power failure), you get a full refund of everything paid or a free reschedule — your choice.</p>
      <h2>Payment issues</h2>
      <p>Your slot is held for {s.holdMinutes} minutes while you pay. If payment succeeds after the hold expires and the slot has been taken by someone else, the full amount is refunded automatically. If money was deducted but your booking isn&apos;t confirmed, contact us with your booking code.</p>
      <h2>Contact</h2>
      <p>Call or WhatsApp {siteConfig.phoneDisplay} or email <a href={`mailto:${siteConfig.email}`}>{siteConfig.email}</a>.</p>
    </LegalPage>
  );
}
