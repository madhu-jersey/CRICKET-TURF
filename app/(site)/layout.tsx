import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { DemoBanner, MobileBookBar } from "@/components/site/misc";
import { env } from "@/lib/env";
import { getSettings } from "@/lib/booking/data";
import { siteConfig } from "@/config/site";

// Every public page reads live settings/availability, so nothing is prerendered at build time.
export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings().catch(() => null);
  return (
    <div className="flex min-h-dvh flex-col bg-pitch-950 text-chalk">
      <a href="#main" className="sr-only z-50 rounded-full bg-flood px-4 py-2 font-bold text-flood-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      {env.demoMode && <DemoBanner />}
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter address={settings?.address ?? siteConfig.streetAddress} phone={settings?.phone ?? siteConfig.phoneE164} />
      <MobileBookBar />
    </div>
  );
}
