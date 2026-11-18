import Image from "next/image";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { siteConfig, type SportKey } from "@/config/site";
import { getDb, schema } from "@/db/client";
import { listCourts, nextFreeSlots, startingPrices, getSettings } from "@/lib/booking/data";
import { ButtonLink } from "@/components/ui/button";
import { Reveal } from "@/components/site/misc";
import { JsonLd } from "@/components/site/json-ld";
import { formatMinutes, istDateKey, timeToMinutes } from "@/lib/time";
import { inr } from "@/lib/utils";
import { policySummary } from "@/lib/policy";

export const dynamic = "force-dynamic";

async function pricingTable() {
  const db = await getDb();
  const courts = await listCourts(db, { activeOnly: true });
  const rules = await db.select().from(schema.pricingRules).orderBy(asc(schema.pricingRules.startTime));
  const out: { sport: SportKey; rows: { label: string; weekday?: number; weekend?: number }[] }[] = [];
  for (const sport of ["CRICKET", "PICKLEBALL"] as SportKey[]) {
    const court = courts.find((c) => c.sport === sport);
    if (!court) continue;
    const r = rules.filter((x) => x.courtId === court.id);
    const bands = [...new Set(r.filter((x) => x.dayType === "WEEKDAY").map((x) => `${x.startTime}-${x.endTime}`))];
    out.push({
      sport,
      rows: bands.map((band) => {
        const [s, e] = band.split("-");
        const wkEnd = r.find((x) => x.dayType === "WEEKEND" && timeToMinutes(x.startTime) <= timeToMinutes(s) && timeToMinutes(s) < timeToMinutes(x.endTime));
        return {
          label: `${timeToMinutes(s) >= 18 * 60 ? "Night" : "Day"} · ${formatMinutes(timeToMinutes(s))} – ${formatMinutes(timeToMinutes(e) % 1440 || 1440).replace("12:00 AM", "Midnight")}`,
          weekday: r.find((x) => x.dayType === "WEEKDAY" && x.startTime === s)?.pricePerSlot,
          weekend: wkEnd?.pricePerSlot,
        };
      }),
    });
  }
  return out;
}

export default async function HomePage() {
  const db = await getDb();
  const [cricketFree, pickleFree, prices, table, featured, settings] = await Promise.all([
    nextFreeSlots("CRICKET", 6),
    nextFreeSlots("PICKLEBALL", 6),
    startingPrices(),
    pricingTable(),
    db.select().from(schema.galleryImages).where(eq(schema.galleryImages.isFeatured, true)).orderBy(asc(schema.galleryImages.sortOrder)).limit(6),
    getSettings(),
  ]);
  const todayKey = istDateKey(new Date());
  const advanceText = settings.advanceType === "FIXED" ? inr(settings.advanceValue) : `${settings.advanceValue}%`;

  return (
    <>
      <JsonLd address={settings.address} phone={settings.phone} />
      {/* Hero */}
      <section className="relative -mt-16 flex min-h-[88svh] items-end overflow-hidden pb-14 pt-32 sm:items-center sm:pb-0">
        <Image src={siteConfig.images.hero} alt="Floodlit ground at night" fill priority sizes="100vw" className="animate-[kenburns_14s_ease-out_both] object-cover motion-reduce:animate-none" />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-pitch-950 via-pitch-950/70 to-pitch-950/30" />
        <div aria-hidden className="absolute inset-0 animate-[glow_5s_ease-in-out_infinite] bg-[radial-gradient(60%_50%_at_80%_0%,rgb(214_255_61/0.22),transparent_60%)] motion-reduce:animate-none" />
        <div className="relative mx-auto w-full max-w-6xl px-4 sm:px-6">
          <p className="animate-rise font-display text-sm font-bold uppercase tracking-[0.35em] text-flood">{siteConfig.city} · Open till 11 PM</p>
          <h1 className="mt-4 animate-rise font-display text-[clamp(3.2rem,11vw,7.5rem)] font-extrabold uppercase leading-[0.86] [animation-delay:80ms]">
            Play under
            <br />
            <span className="text-flood">the lights.</span>
          </h1>
          <p className="mt-6 max-w-xl animate-rise text-lg text-chalk/85 [animation-delay:160ms]">
            Box cricket and pickleball on match-grade turf. Pick a slot, verify your number, pay {advanceText} to lock it in. The rest at the ground.
          </p>
          {settings.newCustomerDiscountPercent > 0 && (
            <p className="mt-5 inline-flex animate-rise items-center gap-2 rounded-full border border-flood/60 bg-pitch-950/60 px-4 py-1.5 text-sm font-semibold text-flood backdrop-blur [animation-delay:200ms]">
              New player? {settings.newCustomerDiscountPercent}% off your first booking
            </p>
          )}
          <div className="mt-8 flex animate-rise flex-col gap-3 [animation-delay:240ms] sm:flex-row">
            <ButtonLink href="/book?sport=cricket" size="lg" className="shine h-16 text-lg">Book cricket</ButtonLink>
            <ButtonLink href="/book?sport=pickleball" variant="outline" size="lg" className="h-16 text-lg backdrop-blur">Book pickleball</ButtonLink>
          </div>
        </div>
      </section>

      {/* Live availability */}
      <section aria-labelledby="live-heading" className="border-y border-white/10 bg-pitch-900">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="flex items-center gap-3">
            <span aria-hidden className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-flood opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2.5 rounded-full bg-flood" />
            </span>
            <h2 id="live-heading" className="font-display text-2xl font-bold uppercase tracking-wide">Live availability</h2>
          </div>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            {[
              { sport: "CRICKET" as const, data: cricketFree },
              { sport: "PICKLEBALL" as const, data: pickleFree },
            ].map(({ sport, data }) => (
              <div key={sport}>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-mist">
                  {siteConfig.sports[sport].label} · {data.dateKey === todayKey ? "today" : "tomorrow"}
                </h3>
                {data.items.length === 0 ? (
                  <p className="mt-3 text-mist">Fully booked for now — check other dates.</p>
                ) : (
                  <ul className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
                    {data.items.map(({ court, slot }) => (
                      <li key={slot.startAt}>
                        <Link
                          href={`/book?sport=${siteConfig.sports[sport].slug}&court=${court.id}&date=${data.dateKey}&time=${slot.time}`}
                          className="group flex min-w-[92px] flex-col items-center rounded-xl border border-white/15 bg-pitch-850 px-3 py-2.5 transition hover:border-flood hover:bg-pitch-800"
                        >
                          <span className="font-display text-xl font-bold tabular-nums group-hover:text-flood">{slot.label}</span>
                          <span className="text-xs text-mist">{inr(slot.price)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Sports */}
      <section aria-labelledby="sports-heading" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="sports-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">Two games. One arena.</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {(["CRICKET", "PICKLEBALL"] as const).map((sport, i) => {
            const s = siteConfig.sports[sport];
            return (
              <Reveal key={sport} delay={i * 100} className="group overflow-hidden rounded-3xl border border-white/10 bg-pitch-900">
                <div className="relative aspect-[16/10] overflow-hidden">
                  <Image src={sport === "CRICKET" ? siteConfig.images.cricketCard : siteConfig.images.pickleballCard} alt={sport === "CRICKET" ? "Batter playing a shot" : "Pickleball paddles and balls"} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover transition duration-700 group-hover:scale-105" />
                  <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-pitch-900 to-transparent" />
                  <h3 className="absolute bottom-4 left-5 font-display text-4xl font-extrabold uppercase">{s.label}</h3>
                </div>
                <div className="p-5 sm:p-6">
                  <p className="text-mist">{s.blurb}</p>
                  <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-white/10 pt-5 text-sm">
                    <div><dt className="text-haze">Court</dt><dd className="mt-1 font-semibold">{s.courtSize}</dd></div>
                    <div><dt className="text-haze">Players</dt><dd className="mt-1 font-semibold">{s.players}</dd></div>
                    <div><dt className="text-haze">Slot</dt><dd className="mt-1 font-semibold">60 min</dd></div>
                  </dl>
                  <div className="mt-6 flex items-center justify-between">
                    <p>
                      <span className="text-sm text-mist">from </span>
                      <span className="font-display text-3xl font-bold text-flood">{prices[sport] ? inr(prices[sport]!) : "—"}</span>
                      <span className="text-sm text-mist"> / hour</span>
                    </p>
                    <ButtonLink href={`/book?sport=${s.slug}`} size="sm">Book</ButtonLink>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" aria-labelledby="pricing-heading" className="scroll-mt-20 bg-chalk text-ink">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 id="pricing-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">Pricing</h2>
          <p className="mt-2 text-zinc-600">Per 60-minute slot. Holidays are charged at weekend rates. Pay {advanceText} online, the balance at the venue.</p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {table.map((t) => (
              <div key={t.sport} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                <table className="w-full text-left">
                  <caption className="bg-ink px-5 py-3 text-left font-display text-xl font-bold uppercase tracking-wide text-chalk">{siteConfig.sports[t.sport].label}</caption>
                  <thead>
                    <tr className="border-b border-zinc-200 text-sm text-zinc-500">
                      <th scope="col" className="px-5 py-3 font-semibold">Time</th>
                      <th scope="col" className="px-5 py-3 text-right font-semibold">Mon–Fri</th>
                      <th scope="col" className="px-5 py-3 text-right font-semibold">Sat–Sun</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r) => (
                      <tr key={r.label} className="border-b border-zinc-100 last:border-0">
                        <th scope="row" className="px-5 py-4 text-sm font-semibold">{r.label}</th>
                        <td className="px-5 py-4 text-right font-display text-2xl font-bold tabular-nums">{r.weekday ? inr(r.weekday) : "—"}</td>
                        <td className="px-5 py-4 text-right font-display text-2xl font-bold tabular-nums">{r.weekend ? inr(r.weekend) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section aria-labelledby="how-heading" className="floodlit">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 id="how-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">Booked in a minute</h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { t: "Pick your slot", d: "Choose sport, date and one or more back-to-back hours. Prices update live." },
              { t: "Verify your phone", d: "Enter the 6-digit code we send you. No passwords, no app." },
              { t: `Pay ${advanceText} advance`, d: "Secure UPI or card payment. Confirmation lands on WhatsApp instantly." },
            ].map((s, i) => (
              <Reveal as="li" key={s.t} delay={i * 120} className="rounded-2xl border border-white/10 bg-pitch-900/80 p-6">
                <span className="font-display text-6xl font-extrabold text-flood/90">0{i + 1}</span>
                <h3 className="mt-3 font-display text-2xl font-bold uppercase">{s.t}</h3>
                <p className="mt-2 text-mist">{s.d}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* Amenities */}
      <section aria-labelledby="amenities-heading" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="amenities-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">At the ground</h2>
        <ul className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3">
          {siteConfig.amenities.map((a) => (
            <li key={a.title} className="bg-pitch-950 p-5 sm:p-7">
              <span aria-hidden className="mb-4 block h-1 w-8 rounded bg-flood" />
              <h3 className="font-display text-xl font-bold uppercase">{a.title}</h3>
              <p className="mt-1 text-sm text-mist">{a.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Gallery preview */}
      <section aria-labelledby="gallery-heading" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <h2 id="gallery-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">Gallery</h2>
          <Link href="/gallery" className="font-semibold text-flood hover:underline">See all photos →</Link>
        </div>
        <ul className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
          {featured.map((g, i) => (
            <li key={g.id} className={i === 0 ? "col-span-2 row-span-2 md:col-span-1" : ""}>
              <Link href="/gallery" className="relative block aspect-square overflow-hidden rounded-2xl">
                <Image src={g.url} alt={g.alt} fill sizes="(min-width: 768px) 33vw, 50vw" className="object-cover transition duration-500 hover:scale-105" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Location */}
      <section aria-labelledby="location-heading" className="border-t border-white/10 bg-pitch-900">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-20 sm:px-6 md:grid-cols-2 md:items-center">
          <div>
            <h2 id="location-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">Find us</h2>
            <address className="mt-4 text-lg not-italic text-mist">{settings.address}</address>
            <p className="mt-2 text-mist">Open every day, 6:00 AM – 11:00 PM</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink href={siteConfig.directionsUrl} target="_blank" rel="noopener noreferrer">Get directions</ButtonLink>
              <ButtonLink href={`tel:${settings.phone}`} variant="outline">Call us</ButtonLink>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-white/10">
            <iframe title={`Map showing ${siteConfig.name}`} src={siteConfig.mapEmbedUrl} className="aspect-[4/3] w-full grayscale-[40%]" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section aria-labelledby="faq-heading" className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <h2 id="faq-heading" className="font-display text-4xl font-extrabold uppercase sm:text-5xl">FAQ</h2>
        <div className="mt-8 divide-y divide-white/10 border-y border-white/10">
          {siteConfig.faqs.map((f) => (
            <details key={f.q} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <span aria-hidden className="text-2xl text-flood transition group-open:rotate-45">+</span>
              </summary>
              <p className="pb-5 text-mist">{f.a === "POLICY" ? `Yes. ${policySummary(settings)}` : f.a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
