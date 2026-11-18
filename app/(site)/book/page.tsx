import type { Metadata } from "next";
import { BookingForm } from "@/components/booking/booking-form";
import { policySummary } from "@/lib/policy";
import { getSettings, listCourts, startingPrices } from "@/lib/booking/data";
import { bookableDates } from "@/lib/booking/slots";
import { istDateKey, istToUtc, relativeDayLabel, formatDateShort } from "@/lib/time";
import type { SportKey } from "@/config/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Book a slot",
  description: "Pick a sport, date and time, verify your phone and pay a small advance to confirm your box cricket or pickleball slot.",
  alternates: { canonical: "/book" },
};

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const [courts, settings, fromPrices] = await Promise.all([listCourts(undefined, { activeOnly: true }), getSettings(), startingPrices()]);
  const now = new Date();
  const today = istDateKey(now);
  const dates = bookableDates(now, settings.maxDaysAhead).map((key) => ({ key, label: relativeDayLabel(key, today), sub: formatDateShort(istToUtc(key, 720)) }));
  const sportParam = one("sport")?.toUpperCase();
  const sport = sportParam === "CRICKET" || sportParam === "PICKLEBALL" ? (sportParam as SportKey) : undefined;
  const time = one("time");

  return (
    <div className="floodlit min-h-[80vh]">
      <div className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6 sm:pt-12 lg:pb-16">
        <h1 className="animate-rise font-display text-5xl font-extrabold uppercase leading-none sm:text-6xl">
          Book <span className="text-flood">a slot</span>
        </h1>
        <p className="mb-7 mt-3 max-w-xl text-mist">
          4 easy steps: choose the game, the day, the time, and pay a small advance. Done in 1 minute.
          {settings.newCustomerDiscountPercent > 0 && <strong className="mt-1 block text-flood">New here? {settings.newCustomerDiscountPercent}% off your first booking.</strong>}
        </p>
        <BookingForm
          courts={courts.map((c) => ({ id: c.id, name: c.name, sport: c.sport }))}
          dates={dates}
          fromPrices={fromPrices}
          settings={{
            advanceType: settings.advanceType,
            advanceValue: settings.advanceValue,
            policy: policySummary(settings),
            holdMinutes: settings.holdMinutes,
            offerPercent: settings.newCustomerDiscountPercent,
          }}
          initial={{ sport, courtId: one("court"), date: one("date"), time: time && /^\d{2}:\d{2}$/.test(time) ? time : undefined }}
        />
      </div>
    </div>
  );
}
