import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Privacy policy", alternates: { canonical: "/privacy" } };

export default function Privacy() {
  return (
    <LegalPage title="Privacy policy" updated="November 2026">
      <p>{siteConfig.name} collects only what is needed to run your bookings. This policy explains what we collect and why, in line with India&apos;s Digital Personal Data Protection Act, 2023.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Your name and mobile number, to identify your booking and verify it is you (one-time codes).</li>
        <li>Booking details: court, date, time, amounts paid and refunded.</li>
        <li>Your WhatsApp preference and the time you gave consent.</li>
        <li>Basic technical data (IP address) to prevent abuse such as repeated code requests.</li>
      </ul>
      <h2>Payments</h2>
      <p>Payments are processed by Razorpay. We never see or store your card, UPI PIN or bank details; we only receive a payment reference and status.</p>
      <h2>WhatsApp messages</h2>
      <p>If you opt in, we send booking confirmations, reminders and cancellation notices on WhatsApp through our messaging provider. We don&apos;t send marketing messages. You can opt out any time by telling us on WhatsApp or at the counter.</p>
      <h2>Sharing</h2>
      <p>We share data only with service providers that help us run bookings (payment gateway, messaging provider, hosting), and when required by law. We never sell your data.</p>
      <h2>Retention & your rights</h2>
      <p>Booking records are kept for up to 3 years for accounting. You can ask us to access, correct or delete your data by contacting <a href={`mailto:${siteConfig.email}`}>{siteConfig.email}</a>.</p>
      <h2>Cookies</h2>
      <p>We use only essential cookies: one to remember that you verified your phone (30 minutes), a random device ID that makes sure the new-customer offer is used once per phone, and, for staff, a login session. No advertising trackers.</p>
    </LegalPage>
  );
}
