/**
 * Demo seed: courts, hours, pricing, holidays, settings, admins, ~15 customers, ~40 bookings
 * (past 14 days + next 7 days), blocked slots, gallery images and sample message logs.
 * Deterministic (seeded PRNG) relative to "now", so charts always look alive.
 */
import bcrypt from "bcryptjs";
import { count } from "drizzle-orm";
import type { DB } from "./client";
import * as schema from "./schema";
import { siteConfig } from "../config/site";
import { addDays, istDateKey, istToUtc, dayOfWeek, minutesToHHMM } from "../lib/time";
import { getDayType, priceForSlot, priceBreakdown, type PricingRuleLite } from "../lib/pricing";
import { renderTemplate } from "../lib/messaging/templates";

function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const CUSTOMERS: [string, string][] = [
  ["Ravi Teja", "9848012345"],
  ["Sai Kiran", "9866123456"],
  ["Lakshmi Prasanna", "9701234567"],
  ["Venkatesh Varma", "9912345678"],
  ["Anil Kumar", "9989123456"],
  ["Pavan Kalyan R", "9550123456"],
  ["Harsha Vardhan", "9440123456"],
  ["Divya Sri", "9963123456"],
  ["Mahesh Babu K", "9676123456"],
  ["Srinivas Raju", "9391123456"],
  ["Keerthi Reddy", "9030123456"],
  ["Naveen Chowdary", "8885123456"],
  ["Bhavana M", "8977123456"],
  ["Rajesh Naidu", "7702123456"],
  ["Suresh Gupta", "6301123456"],
];

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function seedDatabase(db: DB, now = new Date()) {
  const rand = prng(20261117);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const today = istDateKey(now);

  // Sports & courts
  const [cricket, pickle] = await db
    .insert(schema.sports)
    .values([
      { name: "CRICKET", description: siteConfig.sports.CRICKET.blurb, slotDurationMinutes: 60, sortOrder: 1 },
      { name: "PICKLEBALL", description: siteConfig.sports.PICKLEBALL.blurb, slotDurationMinutes: 60, sortOrder: 2 },
    ])
    .returning();
  const courts = await db
    .insert(schema.courts)
    .values([
      { sportId: cricket.id, name: "Box Cricket Arena", sortOrder: 1 },
      { sportId: pickle.id, name: "Pickleball Court 1", sortOrder: 2 },
      { sportId: pickle.id, name: "Pickleball Court 2", sortOrder: 3 },
    ])
    .returning();

  await db.insert(schema.operatingHours).values(courts.flatMap((c) => Array.from({ length: 7 }, (_, d) => ({ courtId: c.id, dayOfWeek: d, openTime: "06:00", closeTime: "23:00" }))));

  const rulesFor = (day: number, night: number, weekendBump: number): PricingRuleLite[] => [
    { dayType: "WEEKDAY", startTime: "06:00", endTime: "18:00", pricePerSlot: day },
    { dayType: "WEEKDAY", startTime: "18:00", endTime: "24:00", pricePerSlot: night },
    { dayType: "WEEKEND", startTime: "06:00", endTime: "18:00", pricePerSlot: day + weekendBump },
    { dayType: "WEEKEND", startTime: "18:00", endTime: "24:00", pricePerSlot: night + weekendBump },
    { dayType: "HOLIDAY", startTime: "06:00", endTime: "18:00", pricePerSlot: day + weekendBump },
    { dayType: "HOLIDAY", startTime: "18:00", endTime: "24:00", pricePerSlot: night + weekendBump },
  ];
  const courtRules = new Map<string, PricingRuleLite[]>();
  courts.forEach((c, i) => courtRules.set(c.id, i === 0 ? rulesFor(800, 1200, 200) : rulesFor(400, 600, 200)));
  await db.insert(schema.pricingRules).values(courts.flatMap((c) => courtRules.get(c.id)!.map((r) => ({ ...r, courtId: c.id }))));

  const year = Number(today.slice(0, 4));
  const xmas = `${today.slice(5) > "12-25" ? year + 1 : year}-12-25`;
  const holidays = [
    { date: addDays(today, 6), name: "Venue Anniversary" },
    { date: xmas, name: "Christmas" },
  ];
  await db.insert(schema.holidays).values(holidays).onConflictDoNothing();
  const holidayKeys = new Set(holidays.map((h) => h.date));

  await db
    .insert(schema.settings)
    .values({
      id: 1,
      advanceType: "FIXED",
      advanceValue: 300,
      holdMinutes: 10,
      cancellationCutoffHours: 2,
      refundPercentBeforeCutoff: 100,
      maxDaysAhead: 14,
      ownerAlertPhone: siteConfig.phoneE164,
      businessName: siteConfig.name,
      address: `${siteConfig.streetAddress}, ${siteConfig.region} ${siteConfig.postalCode}`,
      mapLink: siteConfig.mapLink,
      phone: siteConfig.phoneE164,
    })
    .onConflictDoNothing();

  const hash = await bcrypt.hash("Demo@1234", Number(process.env.BCRYPT_COST) || 12);
  await db
    .insert(schema.adminUsers)
    .values([
      { email: "owner@demo.com", name: "Demo Owner", passwordHash: hash, role: "OWNER" },
      { email: "staff@demo.com", name: "Demo Staff", passwordHash: hash, role: "STAFF" },
    ])
    .onConflictDoNothing();

  const customers = await db
    .insert(schema.customers)
    .values(
      CUSTOMERS.map(([name, phone], i) => ({
        name,
        phone: `+91${phone}`,
        whatsappOptIn: i % 4 !== 3,
        optInAt: i % 4 !== 3 ? new Date(now.getTime() - (30 - i) * 86_400_000) : null,
        createdAt: new Date(now.getTime() - (40 - i) * 86_400_000),
      })),
    )
    .returning();

  // Blocks: recurring Monday 06–08 maintenance on cricket (next 4 weeks) + a pickleball tournament.
  const blocks: { courtId: string; startAt: Date; endAt: Date; reason: schema.BlockReason; note: string; recurrenceGroupId?: string }[] = [];
  const recurId = "seed-monday-maintenance";
  for (let d = 0; d < 28; d++) {
    const key = addDays(today, d);
    if (dayOfWeek(key) === 1) blocks.push({ courtId: courts[0].id, startAt: istToUtc(key, "06:00"), endAt: istToUtc(key, "08:00"), reason: "MAINTENANCE", note: "Weekly turf grooming", recurrenceGroupId: recurId });
  }
  const tDay = addDays(today, 3);
  blocks.push({ courtId: courts[1].id, startAt: istToUtc(tDay, "18:00"), endAt: istToUtc(tDay, "21:00"), reason: "TOURNAMENT", note: "Bhimavaram Pickleball Open — qualifiers" });
  blocks.push({ courtId: courts[2].id, startAt: istToUtc(addDays(today, 5), "07:00"), endAt: istToUtc(addDays(today, 5), "09:00"), reason: "PRIVATE_EVENT", note: "Corporate session" });
  await db.insert(schema.blockedSlots).values(blocks.map((b) => ({ ...b, createdBy: "owner@demo.com" })));

  // Bookings
  const taken = new Map<string, [number, number][]>();
  const free = (courtId: string, s: number, e: number) =>
    !(taken.get(courtId) ?? []).some(([a, b]) => s < b && a < e) && !blocks.some((b) => b.courtId === courtId && s < b.endAt.getTime() && b.startAt.getTime() < e);
  const msgs: (typeof schema.messageLogs.$inferInsert)[] = [];
  let made = 0;
  let guard = 0;
  while (made < 42 && guard++ < 2000) {
    const offset = Math.floor(rand() * 22) - 14; // -14 … +7
    const dateKey = addDays(today, offset);
    const court = rand() < 0.5 ? courts[0] : pick(courts.slice(1));
    const hour = 6 + Math.floor(rand() * 16);
    const hours = rand() < 0.3 ? 2 : 1;
    if (hour + hours > 23) continue;
    const startAt = istToUtc(dateKey, hour * 60);
    const endAt = istToUtc(dateKey, (hour + hours) * 60);
    // Keep today's evening mostly free so the live strip has slots; skip slots in progress.
    if (offset === 0 && (startAt.getTime() < now.getTime() + 3_600_000 || rand() < 0.6)) continue;
    if (!free(court.id, startAt.getTime(), endAt.getTime())) continue;
    taken.set(court.id, [...(taken.get(court.id) ?? []), [startAt.getTime(), endAt.getTime()]]);

    const dayType = getDayType(dateKey, holidayKeys);
    const prices = Array.from({ length: hours }, (_, i) => priceForSlot(courtRules.get(court.id)!, dayType, (hour + i) * 60) ?? 0);
    const r = rand();
    const source: schema.BookingSource = r < 0.7 ? "ONLINE" : r < 0.88 ? "WALK_IN" : "PHONE";
    const isPast = endAt.getTime() < now.getTime();
    const s = rand();
    let status: schema.BookingStatus;
    if (isPast) status = s < 0.78 ? "COMPLETED" : s < 0.86 ? "NO_SHOW" : s < 0.93 ? "CANCELLED" : "REFUNDED";
    else status = s < 0.88 ? "CONFIRMED" : "CANCELLED";
    if (source !== "ONLINE" && status === "REFUNDED") status = "CANCELLED";

    const { total, advance, balance } = priceBreakdown(prices, { advanceType: "FIXED", advanceValue: 300 });
    const customer = pick(customers);
    let code = "BBA-";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
    const createdAt = new Date(Math.min(startAt.getTime() - (1 + rand() * 4) * 86_400_000, now.getTime() - 3_600_000));
    const paidAdvance = source === "ONLINE" ? advance : status === "CANCELLED" ? 0 : Math.round(total * (rand() < 0.5 ? 1 : 0.5));
    const balanceAmt = source === "ONLINE" ? balance : total - paidAdvance;
    const balancePaid = (status === "COMPLETED" || status === "NO_SHOW") && balanceAmt > 0 && status === "COMPLETED";
    const [b] = await db
      .insert(schema.bookings)
      .values({
        bookingCode: code,
        customerId: customer.id,
        courtId: court.id,
        startAt,
        endAt,
        status,
        totalAmount: total,
        advanceAmount: source === "ONLINE" ? advance : paidAdvance,
        balanceAmount: balanceAmt,
        balancePaidAt: balancePaid ? endAt : balanceAmt === 0 ? createdAt : null,
        refundAmount: status === "REFUNDED" ? advance : 0,
        source,
        cancelledAt: status === "CANCELLED" || status === "REFUNDED" ? new Date(createdAt.getTime() + 86_400_000) : null,
        cancelReason: status === "CANCELLED" || status === "REFUNDED" ? "Cancelled by customer" : null,
        reminderSentAt: isPast && status !== "CANCELLED" && status !== "REFUNDED" ? new Date(startAt.getTime() - 2 * 3_600_000) : null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    made++;

    if (source === "ONLINE") {
      const paidOk = status !== "CANCELLED" || rand() < 0.5;
      if (paidOk) {
        await db.insert(schema.payments).values({
          bookingId: b.id,
          provider: "mock",
          kind: "ADVANCE",
          providerOrderId: `order_seed_${code}`,
          providerPaymentId: `pay_seed_${code}`,
          amount: advance,
          status: status === "REFUNDED" ? "REFUNDED" : "PAID",
          refundAmount: status === "REFUNDED" ? advance : 0,
          providerRefundId: status === "REFUNDED" ? `rfnd_seed_${code}` : null,
          paidAt: createdAt,
          refundedAt: status === "REFUNDED" ? new Date(createdAt.getTime() + 86_400_000) : null,
          createdAt,
          updatedAt: createdAt,
        });
      }
    } else if (paidAdvance > 0) {
      await db.insert(schema.payments).values({ bookingId: b.id, provider: rand() < 0.5 ? "CASH" : "UPI", kind: "ADVANCE", amount: paidAdvance, status: "PAID", paidAt: createdAt, createdAt, updatedAt: createdAt });
    }
    if (balancePaid) {
      await db.insert(schema.payments).values({ bookingId: b.id, provider: rand() < 0.6 ? "UPI" : "CASH", kind: "BALANCE", amount: balanceAmt, status: "PAID", paidAt: endAt, createdAt: endAt, updatedAt: endAt });
    }

    if (customer.whatsappOptIn && status !== "CANCELLED" && msgs.length < 14) {
      const params = {
        name: customer.name,
        sport: court.id === courts[0].id ? "Box Cricket" : "Pickleball",
        court: court.name,
        date: dateKey,
        time: `${minutesToHHMM(hour * 60)}–${minutesToHHMM((hour + hours) * 60)}`,
        code,
        advance: `₹${source === "ONLINE" ? advance : paidAdvance}`,
        balance: `₹${balanceAmt}`,
        map: siteConfig.directionsUrl,
      };
      const failed = msgs.length === 5;
      msgs.push({
        bookingId: b.id,
        phone: customer.phone,
        template: "booking_confirmed",
        payload: params,
        renderedText: renderTemplate("booking_confirmed", params),
        status: failed ? "FAILED" : "MOCKED",
        provider: "mock",
        attempts: failed ? 3 : 1,
        providerMessageId: failed ? null : `mock_seed_${code}`,
        error: failed ? "Attempt 3: Recipient phone number not on WhatsApp (demo)" : null,
        dedupeKey: `booking_confirmed:${b.id}`,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  if (msgs.length) await db.insert(schema.messageLogs).values(msgs);

  await db.insert(schema.galleryImages).values(
    siteConfig.gallery.map((g, i) => ({ url: g.url, category: g.category, alt: g.alt, isFeatured: g.featured, sortOrder: i })),
  );

  return { courts: courts.length, customers: customers.length, bookings: made, blocks: blocks.length };
}

export async function autoSeedIfEmpty(db: DB) {
  const [{ n }] = await db.select({ n: count() }).from(schema.sports);
  if (n > 0) return null;
  const result = await seedDatabase(db);
  console.info("[db] seeded demo data", result);
  return result;
}
