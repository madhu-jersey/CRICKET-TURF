/**
 * The ONE place cancellation/refund wording comes from. Every page and message renders policy text
 * from Settings through these functions — no hours or percentages are hardcoded anywhere else
 * (a test greps the codebase to keep it that way). [SEC-40]
 */
export type PolicySettings = {
  cancelCutoffHours: number; // online cancelling closes this many hours before start (0 = until start)
  refundCutoffHours: number; // cancel at least this many hours before start for the "before" refund
  refundPercentBeforeCutoff: number;
  refundPercentAfterCutoff: number;
};

export const hoursText = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);

/** Refund owed for a customer cancellation under the policy. */
export function refundFor(p: PolicySettings, input: { startAt: Date; now: Date; paidAmount: number }): number {
  const before = input.startAt.getTime() - input.now.getTime() >= p.refundCutoffHours * 3_600_000;
  const pct = before ? p.refundPercentBeforeCutoff : p.refundPercentAfterCutoff;
  return Math.round((input.paidAmount * pct) / 100);
}

/** Can the customer still cancel online at `now`? */
export function canCancelOnline(p: PolicySettings, startAt: Date, now: Date): boolean {
  return startAt.getTime() - now.getTime() > p.cancelCutoffHours * 3_600_000;
}

function refundWords(pct: number) {
  return pct >= 100 ? "full refund of the advance" : pct <= 0 ? "no refund" : `${pct}% of the advance back`;
}

/** Bullet points for the refund-policy page. */
export function policyLines(p: PolicySettings): string[] {
  const lines = [
    p.refundCutoffHours > 0
      ? `Cancel ${hoursText(p.refundCutoffHours)} or more before your slot starts: ${refundWords(p.refundPercentBeforeCutoff)}.`
      : `Cancel any time before your slot starts: ${refundWords(p.refundPercentBeforeCutoff)}.`,
  ];
  if (p.refundCutoffHours > 0) lines.push(`Cancel less than ${hoursText(p.refundCutoffHours)} before your slot starts: ${refundWords(p.refundPercentAfterCutoff)}.`);
  lines.push(
    p.cancelCutoffHours > 0
      ? `Online cancelling closes ${hoursText(p.cancelCutoffHours)} before your slot. After that, please call the venue.`
      : `You can cancel online until your slot starts. Slots that have started can't be cancelled online.`,
  );
  return lines;
}

/** One sentence for the booking page, booking status page, FAQ and WhatsApp confirmation. */
export function policySummary(p: PolicySettings): string {
  const before = refundWords(p.refundPercentBeforeCutoff);
  if (p.refundCutoffHours <= 0) return `Cancel before your slot starts for a ${before}.`.replace("for a no refund", "— the advance is not refunded");
  return `Cancel ${hoursText(p.refundCutoffHours)} or more before your slot for a ${before}; later cancellations get ${refundWords(p.refundPercentAfterCutoff)}.`.replace(
    "for a no refund",
    "— the advance is not refunded",
  );
}

/** Refund line for the WhatsApp cancellation message. */
export function cancelledRefundText(p: PolicySettings, refunded: number, formatted: string): string {
  if (refunded > 0) return formatted;
  return p.refundCutoffHours > 0 ? `No refund (cancelled less than ${hoursText(p.refundCutoffHours)} before the slot)` : "No refund";
}
