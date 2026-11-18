import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";
import { siteConfig } from "@/config/site";
import { getSettings } from "@/lib/booking/data";
import { ButtonLink } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact us", description: `Call, WhatsApp or visit ${siteConfig.name} in ${siteConfig.city}.`, alternates: { canonical: "/contact" } };

export default async function Contact() {
  const s = await getSettings();
  const wa = `https://wa.me/${s.phone.replace(/\D/g, "")}`;
  return (
    <LegalPage title="Contact us" updated="November 2026">
      <p>We&apos;re at the ground every day from 6:00 AM to 11:00 PM.</p>
      <h2>Venue</h2>
      <p>
        <strong>{s.businessName}</strong>
        <br />
        {s.address}
      </p>
      <h2>Phone & WhatsApp</h2>
      <p>
        <a href={`tel:${s.phone}`}>{s.phone.replace(/^\+91(\d{5})(\d{5})$/, "+91 $1 $2")}</a>
      </p>
      <h2>Email</h2>
      <p>
        <a href={`mailto:${siteConfig.email}`}>{siteConfig.email}</a>
      </p>
      <div className="flex flex-wrap gap-3 pt-4">
        <ButtonLink href={wa} target="_blank" rel="noopener noreferrer">WhatsApp us</ButtonLink>
        <ButtonLink href={siteConfig.directionsUrl} target="_blank" rel="noopener noreferrer" variant="outline">Get directions</ButtonLink>
      </div>
    </LegalPage>
  );
}
