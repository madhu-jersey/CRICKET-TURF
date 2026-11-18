import Link from "next/link";
import { siteConfig } from "@/config/site";
import { Logo } from "@/components/site/header";

export function SiteFooter({ address, phone }: { address: string; phone: string }) {
  const wa = `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(`Hi ${siteConfig.name}, I'd like to book a slot.`)}`;
  const phoneDisplay = phone.replace(/^\+91(\d{5})(\d{5})$/, "+91 $1 $2");
  return (
    <footer className="border-t border-white/10 bg-pitch-950 pb-28 pt-14 text-mist md:pb-12">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-sm text-sm leading-relaxed">{siteConfig.tagline}. Open daily 6 AM – 11 PM.</p>
          <address className="mt-4 text-sm not-italic leading-relaxed">{address}</address>
        </div>
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-chalk">Contact</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <a className="hover:text-flood" href={`tel:${phone}`}>
                Call {phoneDisplay}
              </a>
            </li>
            <li>
              <a className="hover:text-flood" href={wa} target="_blank" rel="noopener noreferrer">
                Chat on WhatsApp
              </a>
            </li>
            <li>
              <a className="hover:text-flood" href={`mailto:${siteConfig.email}`}>
                {siteConfig.email}
              </a>
            </li>
          </ul>
          <ul className="mt-4 flex gap-4 text-sm">
            <li><a className="hover:text-flood" href={siteConfig.social.instagram} target="_blank" rel="noopener noreferrer">Instagram</a></li>
            <li><a className="hover:text-flood" href={siteConfig.social.facebook} target="_blank" rel="noopener noreferrer">Facebook</a></li>
            <li><a className="hover:text-flood" href={siteConfig.social.youtube} target="_blank" rel="noopener noreferrer">YouTube</a></li>
          </ul>
        </div>
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-chalk">Info</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link className="hover:text-flood" href="/book">Book a slot</Link></li>
            <li><Link className="hover:text-flood" href="/my-bookings">My bookings</Link></li>
            <li><Link className="hover:text-flood" href="/refund-policy">Cancellation & refunds</Link></li>
            <li><Link className="hover:text-flood" href="/terms">Terms</Link></li>
            <li><Link className="hover:text-flood" href="/privacy">Privacy</Link></li>
            <li><Link className="hover:text-flood" href="/contact">Contact us</Link></li>
          </ul>
        </div>
      </div>
      <div className="mx-auto mt-12 max-w-6xl px-4 text-xs text-haze sm:px-6">
        © {new Date().getFullYear()} {siteConfig.name}, {siteConfig.city}. All rights reserved.
      </div>
    </footer>
  );
}
