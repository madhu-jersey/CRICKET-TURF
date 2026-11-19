/**
 * Every migration the code expects, in order. The live startup check compares this with the
 * database's "_migrations" table (the .sql files themselves may not be bundled into a serverless
 * deployment). A unit test fails if this list and db/migrations/ ever disagree. [SEC-52]
 */
export const MIGRATIONS = [
  "0001_init.sql",
  "0002_new_customer_discount.sql",
  "0003_offer_device.sql",
  "0004_two_hour_cancellation.sql",
  "0005_abuse_limits.sql",
  "0006_followup_hardening.sql",
  "0007_admin_recovery_codes.sql",
  "0008_pending_refunds.sql",
  "0009_refund_reconcile.sql",
  "0010_noshow_reset_autocomplete.sql",
] as const;

/** Expected migrations that the database hasn't applied, in order. */
export function missingMigrations(applied: Iterable<string>, expected: readonly string[] = MIGRATIONS): string[] {
  const done = new Set(applied);
  return expected.filter((m) => !done.has(m));
}
