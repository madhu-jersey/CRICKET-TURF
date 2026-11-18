import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { siteConfig } from "@/config/site";
import { getBookingByCode, netPaid } from "@/lib/booking/data";
import { holdResponseFor, previewCustomerRefund } from "@/lib/booking/service";
import { getVerifiedPhone, maskPhone } from "@/lib/auth/phone";
import { formatDate, formatTimeRange } from "@/lib/time";
import { bookingCodeSchema } from "@/lib/validation";
import { PaymentPanel } from "@/components/booking/payment-panel";
import { Celebrate, SuccessTick } from "@/components/booking/celebrate";
import { CancelBooking } from "@/components/booking/cancel-booking";
import { ButtonLink } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { inr } from "@/lib/utils";
import { headers } from "next/headers";
import { hitRateLimit, ipFromHeaders } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your booking", robots: { index: false } };

const STATUS: Record<string, { label: string; cls: string }> = {
  PENDING_PAYMENT: { label: "Awaiting payment", cls: "bg-amber-100 text-amber-900" },
  CONFIRMED: { label: "Confirmed", cls: "bg-flood text-flood-ink" },
  COMPLETED: { label: "Completed", cls: "bg-zinc-200 text-zinc-800" },
  EXPIRED: { label: "Expired", cls: "bg-zinc-200 text-zinc-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-[#ffe1d8] text-[#8a2410]" },
  REFUNDED: { label: "Cancelled · refunded", cls: "bg-sky-100 text-sky-900" },
  NO_SHOW: { label: "No-show", cls: "bg-zinc-200 text-zinc-700" },
};

function gcalLink(title: string, start: Date, end: Date, details: string, location: string) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const p = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${f(start)}/${f(end)}`, details, location });
  return `https://calendar.google.com/calendar/render?${p}`;
}

export default async function BookingPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ paid?: string }> }) {
  const parsed = bookingCodeSchema.safeParse((await params).code);
  if (!parsed.success) notFound();
  const code = parsed.data;
  // Booking pages are reachable by code; cap views per network so codes can't be scanned. [SEC-11]
  if (!(await hitRateLimit(`booking-view:${ipFromHeaders(await headers())}`, 60, 10 * 60_000))) notFound();
  const d = await getBookingByCode(code);
  if (!d) notFound();
  const { paid: justPaid } = await searchParams;
  const b = d.booking;
  const now = new Date();
  const holdAlive = b.status === "PENDING_PAYMENT" && b.holdExpiresAt && b.holdExpiresAt > now;
  const hold = holdAlive ? await holdResponseFor(code, null).catch(() => null) : null;
  const paidOnline = netPaid(d.payments.filter((p) => p.kind === "ADVANCE"));
  const verifiedPhone = await getVerifiedPhone();
  // Anyone with the code sees only first name + masked phone; the verified owner sees their full name. [SEC-05]
  const isOwner = verifiedPhone === d.customer.phone;
  const refundPreview = b.status === "CONFIRMED" && b.startAt > now ? await previewCustomerRefund(code, now) : null;
  const qr = await QRCode.toString(code, { type: "svg", margin: 1, color: { dark: "#0c1510", light: "#ffffff" } });
  const sportLabel = siteConfig.sports[d.sport].label;
  const when = formatTimeRange(b.startAt, b.endAt);
  const status = STATUS[b.status] ?? { label: b.status, cls: "bg-zinc-200" };
  const confirmed = b.status === "CONFIRMED";

  return (
    <div className="floodlit">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        {confirmed && justPaid && (
          <div className="mb-8 text-center" role="status">
            <Celebrate />
            <SuccessTick />
            <h1 className="mt-5 animate-rise font-display text-5xl font-extrabold uppercase [animation-delay:200ms]">You&apos;re booked!</h1>
            <p className="mt-2 animate-rise text-lg text-chalk [animation-delay:300ms]">
              {formatDate(b.startAt)} · {when}
            </p>
            <p className="mt-1 animate-rise text-mist [animation-delay:400ms]">
              {d.customer.whatsappOptIn ? `Details sent on WhatsApp to ${maskPhone(d.customer.phone)}.` : "Take a screenshot — show this at the counter."}
            </p>
          </div>
        )}
        {!(confirmed && justPaid) && <h1 className="mb-6 font-display text-5xl font-extrabold uppercase">Your booking</h1>}

        <article className="animate-rise overflow-hidden rounded-[28px] bg-white text-ink shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] [animation-delay:350ms]">
          <header className="flex items-center justify-between gap-4 bg-ink px-6 py-5 text-chalk">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-mist">Booking code</p>
              <p className="font-mono text-2xl font-bold tracking-wider text-flood" data-testid="booking-code">{code}</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${status.cls}`} data-testid="booking-status">{status.label}</span>
          </header>

          <div className="grid gap-6 p-6 sm:grid-cols-[1fr_auto]">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
              <div><dt className="text-zinc-500">Sport</dt><dd className="font-semibold">{sportLabel}</dd></div>
              <div><dt className="text-zinc-500">Court</dt><dd className="font-semibold">{d.courtName}</dd></div>
              <div><dt className="text-zinc-500">Date</dt><dd className="font-semibold">{formatDate(b.startAt)}</dd></div>
              <div><dt className="text-zinc-500">Time</dt><dd className="font-semibold">{when}</dd></div>
              <div><dt className="text-zinc-500">Name</dt><dd className="font-semibold">{isOwner ? d.customer.name : d.customer.name.split(" ")[0]}</dd></div>
              <div><dt className="text-zinc-500">Phone</dt><dd className="font-semibold">{maskPhone(d.customer.phone)}</dd></div>
              <div><dt className="text-zinc-500">Total</dt><dd className="font-semibold">{inr(b.totalAmount)}{b.discountAmount > 0 && <span className="block text-xs font-semibold text-emerald-700">You saved {inr(b.discountAmount)} (first booking)</span>}</dd></div>
              <div><dt className="text-zinc-500">{b.status === "PENDING_PAYMENT" ? "Advance due" : "Paid online"}</dt><dd className="font-semibold">{inr(b.status === "PENDING_PAYMENT" ? b.advanceAmount : paidOnline)}</dd></div>
              <div className="col-span-2 rounded-xl bg-zinc-50 px-3 py-2">
                <dt className="text-zinc-500">Balance at venue</dt>
                <dd className="font-display text-2xl font-bold">{b.balancePaidAt ? "Paid" : inr(b.balanceAmount)}</dd>
              </div>
              {b.refundAmount > 0 && (
                <div className="col-span-2"><dt className="text-zinc-500">Refunded</dt><dd className="font-semibold">{inr(b.refundAmount)}</dd></div>
              )}
            </dl>
            {(confirmed || b.status === "COMPLETED") && (
              <figure className="mx-auto w-40 text-center">
                <div className="rounded-xl border border-zinc-200 p-2" dangerouslySetInnerHTML={{ __html: qr }} role="img" aria-label={`QR code for booking ${code}`} />
                <figcaption className="mt-1 text-xs text-zinc-500">Show at the counter</figcaption>
              </figure>
            )}
          </div>

          <div className="space-y-4 border-t border-zinc-100 p-6">
            {hold && <PaymentPanel hold={hold} />}
            {b.status === "PENDING_PAYMENT" && !hold && <Alert tone="warn">The payment window for this booking has closed.</Alert>}
            {b.status === "EXPIRED" && <Alert tone="warn">This hold expired before payment completed, so the slot was released.</Alert>}
            {(b.status === "CANCELLED" || b.status === "REFUNDED") && b.cancelReason && <Alert tone="info">{b.cancelReason}{b.refundAmount > 0 ? ` — ${inr(b.refundAmount)} refunded.` : ""}</Alert>}

            {confirmed && (
              <div className="flex flex-wrap gap-3">
                <ButtonLink href={siteConfig.directionsUrl} target="_blank" rel="noopener noreferrer" variant="dark">Get directions</ButtonLink>
                <ButtonLink
                  href={gcalLink(`${sportLabel} at ${siteConfig.name}`, b.startAt, b.endAt, `Booking ${code}. ${d.courtName}. Balance due at venue: ${inr(b.balanceAmount)}.`, siteConfig.streetAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="light"
                >
                  Add to Google Calendar
                </ButtonLink>
              </div>
            )}
            {confirmed && refundPreview && (
              <CancelBooking bookingCode={code} refund={refundPreview.refund} paid={refundPreview.paid} cutoffHours={refundPreview.cutoffHours} verified={verifiedPhone === d.customer.phone} />
            )}
            {!confirmed && !hold && <ButtonLink href="/book" variant="dark">Book another slot</ButtonLink>}
          </div>
        </article>
        <p className="mt-6 text-center text-sm text-mist">
          Questions? Call <a className="underline" href={`tel:${siteConfig.phoneE164}`}>{siteConfig.phoneDisplay}</a>
        </p>
      </div>
    </div>
  );
}
