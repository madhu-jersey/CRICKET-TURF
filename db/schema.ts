/**
 * Drizzle table definitions. These mirror db/migrations/*.sql exactly; the SQL files are the
 * source of truth (they also contain the exclusion constraint and CHECKs Drizzle can't express).
 */
import { pgTable, text, integer, boolean, timestamp, jsonb, bigserial, bigint, date, customType } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const sports = pgTable("Sport", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").$type<SportName>().notNull(),
  description: text("description").notNull().default(""),
  slotDurationMinutes: integer("slotDurationMinutes").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
});

export const courts = pgTable("Court", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sportId: text("sportId").notNull(),
  name: text("name").notNull(),
  isActive: boolean("isActive").notNull().default(true),
  sortOrder: integer("sortOrder").notNull().default(0),
});

export const operatingHours = pgTable("OperatingHours", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  courtId: text("courtId").notNull(),
  dayOfWeek: integer("dayOfWeek").notNull(),
  openTime: text("openTime").notNull(),
  closeTime: text("closeTime").notNull(),
  isClosed: boolean("isClosed").notNull().default(false),
});

export const pricingRules = pgTable("PricingRule", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  courtId: text("courtId").notNull(),
  dayType: text("dayType").$type<DayType>().notNull(),
  startTime: text("startTime").notNull(),
  endTime: text("endTime").notNull(),
  pricePerSlot: integer("pricePerSlot").notNull(),
});

export const holidays = pgTable("Holiday", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  date: date("date", { mode: "string" }).notNull(),
  name: text("name").notNull(),
});

export const blockedSlots = pgTable("BlockedSlot", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  courtId: text("courtId").notNull(),
  startAt: ts("startAt").notNull(),
  endAt: ts("endAt").notNull(),
  reason: text("reason").$type<BlockReason>().notNull(),
  note: text("note"),
  recurrenceGroupId: text("recurrenceGroupId"),
  createdBy: text("createdBy").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const customers = pgTable("Customer", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  whatsappOptIn: boolean("whatsappOptIn").notNull().default(false),
  optInAt: ts("optInAt"),
  isBlocked: boolean("isBlocked").notNull().default(false),
  blockedAt: ts("blockedAt"),
  blockedReason: text("blockedReason"),
  trustEpoch: integer("trustEpoch").notNull().default(0),
  /** No-shows for slots before this don't count toward auto-blocking (set on unblock). [SEC-57] */
  noShowResetAt: ts("noShowResetAt"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const otpRequests = pgTable("OtpRequest", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  phone: text("phone").notNull(),
  codeHash: text("codeHash").notNull(),
  expiresAt: ts("expiresAt").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: ts("consumedAt"),
  ip: text("ip"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const bookings = pgTable("Booking", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  bookingCode: text("bookingCode").notNull(),
  customerId: text("customerId").notNull(),
  courtId: text("courtId").notNull(),
  startAt: ts("startAt").notNull(),
  endAt: ts("endAt").notNull(),
  status: text("status").$type<BookingStatus>().notNull(),
  totalAmount: integer("totalAmount").notNull(),
  advanceAmount: integer("advanceAmount").notNull(),
  balanceAmount: integer("balanceAmount").notNull(),
  balancePaidAt: ts("balancePaidAt"),
  refundAmount: integer("refundAmount").notNull().default(0),
  /** Refund still owed after a failed refund call; retried by the cron. [SEC-45] */
  refundPendingAmount: integer("refundPendingAmount").notNull().default(0),
  refundPendingSince: ts("refundPendingSince"),
  refundAttempts: integer("refundAttempts").notNull().default(0),
  /** Gave up retrying (24 h or 20 attempts): the owner must refund by hand. [SEC-49] */
  refundNeedsManual: boolean("refundNeedsManual").notNull().default(false),
  discountAmount: integer("discountAmount").notNull().default(0),
  offerDeviceId: text("offerDeviceId"),
  source: text("source").$type<BookingSource>().notNull(),
  holdExpiresAt: ts("holdExpiresAt"),
  cancelledAt: ts("cancelledAt"),
  cancelReason: text("cancelReason"),
  idempotencyKey: text("idempotencyKey"),
  reminderSentAt: ts("reminderSentAt"),
  notes: text("notes"),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const payments = pgTable("Payment", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  bookingId: text("bookingId").notNull(),
  provider: text("provider").$type<PaymentProviderName>().notNull(),
  kind: text("kind").$type<"ADVANCE" | "BALANCE">().notNull().default("ADVANCE"),
  providerOrderId: text("providerOrderId"),
  providerPaymentId: text("providerPaymentId"),
  amount: integer("amount").notNull(),
  status: text("status").$type<PaymentStatus>().notNull(),
  refundAmount: integer("refundAmount").notNull().default(0),
  providerRefundId: text("providerRefundId"),
  /** A refund call whose outcome is unknown: its key, reserved amount and start time. [SEC-49] */
  refundInFlightKey: text("refundInFlightKey"),
  refundInFlightAmount: integer("refundInFlightAmount").notNull().default(0),
  refundInFlightAt: ts("refundInFlightAt"),
  paidAt: ts("paidAt"),
  refundedAt: ts("refundedAt"),
  rawWebhookPayload: jsonb("rawWebhookPayload"),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const messageLogs = pgTable("MessageLog", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  bookingId: text("bookingId"),
  phone: text("phone").notNull(),
  template: text("template").notNull(),
  language: text("language").notNull().default("en"),
  payload: jsonb("payload").$type<Record<string, string>>().notNull(),
  renderedText: text("renderedText").notNull().default(""),
  status: text("status").$type<MessageStatus>().notNull(),
  provider: text("provider").notNull(),
  attempts: integer("attempts").notNull().default(0),
  providerMessageId: text("providerMessageId"),
  error: text("error"),
  dedupeKey: text("dedupeKey"),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const adminUsers = pgTable("AdminUser", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").$type<AdminRole>().notNull(),
  isActive: boolean("isActive").notNull().default(true),
  phone: text("phone"),
  mustChangePassword: boolean("mustChangePassword").notNull().default(false),
  trustEpoch: integer("trustEpoch").notNull().default(0),
  passwordChangedAt: ts("passwordChangedAt"),
  recoveryCodesAt: ts("recoveryCodesAt"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const adminSessions = pgTable("AdminSession", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  adminId: text("adminId").notNull(),
  csrfToken: text("csrfToken").notNull(),
  expiresAt: ts("expiresAt").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const auditLogs = pgTable("AuditLog", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entityId"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const settings = pgTable("Settings", {
  id: integer("id").primaryKey(),
  advanceType: text("advanceType").$type<"FIXED" | "PERCENT">().notNull(),
  advanceValue: integer("advanceValue").notNull(),
  holdMinutes: integer("holdMinutes").notNull(),
  refundCutoffHours: integer("refundCutoffHours").notNull(),
  cancelCutoffHours: integer("cancelCutoffHours").notNull().default(0),
  refundPercentAfterCutoff: integer("refundPercentAfterCutoff").notNull().default(0),
  refundPercentBeforeCutoff: integer("refundPercentBeforeCutoff").notNull(),
  maxDaysAhead: integer("maxDaysAhead").notNull(),
  newCustomerDiscountPercent: integer("newCustomerDiscountPercent").notNull().default(10),
  maxActiveBookingsPerPhone: integer("maxActiveBookingsPerPhone").notNull().default(2),
  maxBookingsPerPhonePerDay: integer("maxBookingsPerPhonePerDay").notNull().default(4),
  noShowBlockThreshold: integer("noShowBlockThreshold").notNull().default(3),
  otpDailyCapNew: integer("otpDailyCapNew").notNull().default(200),
  otpDailyCapReturning: integer("otpDailyCapReturning").notNull().default(300),
  otpCapBoost: integer("otpCapBoost").notNull().default(0),
  otpCapBoostDate: date("otpCapBoostDate", { mode: "string" }),
  otpSendPerIpHour: integer("otpSendPerIpHour").notNull().default(30),
  otpVerifyPerIpHour: integer("otpVerifyPerIpHour").notNull().default(60),
  bookingPerIpHour: integer("bookingPerIpHour").notNull().default(60),
  cancelPerIpHour: integer("cancelPerIpHour").notNull().default(30),
  ownerAlertPhone: text("ownerAlertPhone"),
  businessName: text("businessName").notNull(),
  address: text("address").notNull(),
  mapLink: text("mapLink").notNull(),
  phone: text("phone").notNull(),
  autoCompleteHours: integer("autoCompleteHours").notNull().default(6),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const rateLimitHits = pgTable("RateLimitHit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  key: text("key").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const webhookEvents = pgTable("WebhookEvent", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  type: text("type").notNull(),
  receivedAt: ts("receivedAt").notNull().defaultNow(),
});

export const galleryImages = pgTable("GalleryImage", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  url: text("url").notNull(),
  storageKey: text("storageKey"),
  category: text("category").$type<"CRICKET" | "PICKLEBALL" | "FACILITIES">().notNull(),
  alt: text("alt").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
  isFeatured: boolean("isFeatured").notNull().default(false),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const storedFiles = pgTable("StoredFile", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  contentType: text("contentType").notNull(),
  data: bytea("data").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const counters = pgTable("Counter", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  expiresAt: ts("expiresAt").notNull(),
});

export const cacheVersions = pgTable("CacheVersion", {
  key: text("key").primaryKey(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const adminCodes = pgTable("AdminCode", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  adminId: text("adminId").notNull(),
  purpose: text("purpose").$type<"RESET" | "LOGIN">().notNull(),
  codeHash: text("codeHash").notNull(),
  expiresAt: ts("expiresAt").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: ts("consumedAt"),
  trustDevice: boolean("trustDevice").notNull().default(false),
  ip: text("ip"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const adminRecoveryCodes = pgTable("AdminRecoveryCode", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  adminId: text("adminId").notNull(),
  codeHash: text("codeHash").notNull(),
  usedAt: ts("usedAt"),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export type SportName = "CRICKET" | "PICKLEBALL";
export type DayType = "WEEKDAY" | "WEEKEND" | "HOLIDAY";
export type BlockReason = "MAINTENANCE" | "TOURNAMENT" | "PRIVATE_EVENT" | "OTHER";
export type BookingStatus = "PENDING_PAYMENT" | "CONFIRMED" | "COMPLETED" | "EXPIRED" | "CANCELLED" | "REFUNDED" | "NO_SHOW";
export type BookingSource = "ONLINE" | "WALK_IN" | "PHONE";
export type PaymentProviderName = "razorpay" | "mock" | "CASH" | "UPI" | "CARD";
export type PaymentStatus = "CREATED" | "PAID" | "FAILED" | "REFUNDED";
export type MessageStatus = "QUEUED" | "SENT" | "FAILED" | "MOCKED";
export type AdminRole = "OWNER" | "STAFF";

export type Booking = typeof bookings.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Court = typeof courts.$inferSelect;
export type Sport = typeof sports.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type PricingRuleRow = typeof pricingRules.$inferSelect;
export type OperatingHoursRow = typeof operatingHours.$inferSelect;
export type MessageLogRow = typeof messageLogs.$inferSelect;
export type AdminUser = typeof adminUsers.$inferSelect;
