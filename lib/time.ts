/**
 * Time helpers. Everything is stored in UTC; the venue runs on IST (Asia/Kolkata, UTC+05:30,
 * no daylight saving), so conversions are a fixed offset. A "date key" is an IST calendar date
 * formatted as YYYY-MM-DD; a "time" is HH:MM in IST (with "24:00" allowed as a closing time).
 */
export const IST_OFFSET_MINUTES = 330;
const MS_MIN = 60_000;

const pad = (n: number) => String(n).padStart(2, "0");

function shifted(d: Date) {
  return new Date(d.getTime() + IST_OFFSET_MINUTES * MS_MIN);
}

export function istDateKey(d: Date): string {
  const t = shifted(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Minutes since IST midnight for an instant. */
export function istMinutesOfDay(d: Date): number {
  const t = shifted(d);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export function istTimeHHMM(d: Date): string {
  return minutesToHHMM(istMinutesOfDay(d));
}

export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function timeToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time: ${hhmm}`);
  return h * 60 + min;
}

export function minutesToHHMM(mins: number): string {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

/** Converts an IST wall-clock date + minutes-since-midnight to a UTC instant. */
export function istToUtc(dateKey: string, minutesOrHHMM: number | string): Date {
  const mins = typeof minutesOrHHMM === "number" ? minutesOrHHMM : timeToMinutes(minutesOrHHMM);
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, mins) - IST_OFFSET_MINUTES * MS_MIN);
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for an IST date key. */
export function dayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(fromKey: string, toKey: string): number {
  const a = istToUtc(fromKey, 0).getTime();
  const b = istToUtc(toKey, 0).getTime();
  return Math.round((b - a) / (24 * 60 * MS_MIN));
}

const fmtTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const fmtDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtDateShort = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const fmtWeekday = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" });
const fmtDateTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** "6:00 PM" */
export function formatTime(d: Date): string {
  return fmtTime.format(d).replace(/\s?(am|pm)$/i, (s) => " " + s.trim().toUpperCase());
}
/** "Tue, 18 Nov 2026" */
export function formatDate(d: Date): string {
  return fmtDate.format(d);
}
export function formatDateShort(d: Date): string {
  return fmtDateShort.format(d);
}
export function formatWeekday(d: Date): string {
  return fmtWeekday.format(d);
}
export function formatDateTime(d: Date): string {
  return fmtDateTime.format(d).replace(/\s?(am|pm)$/i, (s) => " " + s.trim().toUpperCase());
}
/** "6:00 PM – 8:00 PM" */
export function formatTimeRange(start: Date, end: Date): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}
/** Label for a time given as minutes since midnight, e.g. 1080 → "6:00 PM". */
export function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

/** "Today" / "Tomorrow" / "Thu" labels for the date strip. */
export function relativeDayLabel(dateKey: string, todayKey: string): string {
  const diff = daysBetween(todayKey, dateKey);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return formatWeekday(istToUtc(dateKey, 12 * 60));
}
