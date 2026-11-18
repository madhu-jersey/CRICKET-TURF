/**
 * One CSV cell: always quoted, and cells that a spreadsheet would treat as a formula
 * (starting with = + - @ tab or CR, even after leading spaces) are prefixed with ' so they show
 * as text instead of running. [SEC-22]
 */
export function csvCell(v: unknown): string {
  const s = String(v ?? "");
  const safe = /^\s*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
