import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Terms & conditions", alternates: { canonical: "/terms" } };

export default function Terms() {
  return (
    <LegalPage title="Terms & conditions" updated="November 2026">
      <p>These terms apply to bookings made with {siteConfig.name}, {siteConfig.city}, {siteConfig.region} (&quot;we&quot;, &quot;the venue&quot;). By booking you agree to them.</p>
      <h2>Bookings</h2>
      <ul>
        <li>A booking is confirmed only after the advance payment succeeds and you receive a booking code.</li>
        <li>Prices are set by the venue and shown before you pay. The balance is payable at the venue before play.</li>
        <li>Please arrive 10 minutes early. Slots end on time so the next group can start; late arrival does not extend your slot.</li>
        <li>Cancellations and refunds follow our <a href="/refund-policy">cancellation & refund policy</a>.</li>
      </ul>
      <h2>Conduct & safety</h2>
      <ul>
        <li>Non-marking sports shoes only on the turf and courts. No metal spikes.</li>
        <li>No smoking, alcohol or glass bottles in the playing area.</li>
        <li>Players are responsible for their own safety and belongings. Use protective gear for hard-ball cricket.</li>
        <li>Damage to nets, lights or equipment caused by misuse may be charged.</li>
      </ul>
      <h2>Venue rights</h2>
      <p>We may refuse or end a session for unsafe or abusive behaviour. If we must close the venue (weather, maintenance, emergencies) we will refund or reschedule as described in the refund policy.</p>
      <h2>Liability</h2>
      <p>To the extent permitted by law, the venue is not liable for injuries or losses arising from participation in sports, except where caused by our negligence.</p>
      <h2>Governing law</h2>
      <p>These terms are governed by the laws of India. Courts in West Godavari district, Andhra Pradesh have jurisdiction.</p>
    </LegalPage>
  );
}
