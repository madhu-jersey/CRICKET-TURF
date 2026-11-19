/**
 * SEC-62: guard against the SEC-48 bug class. postgres-js (production) rejects a JavaScript Date
 * passed into a raw `sql` fragment; PGlite (default tests) accepts it, so such bugs only show up on
 * real Postgres. This scans every raw sql`…` fragment in app code and fails if an interpolated value
 * looks like a Date (now, *At, *Date, cutoff, since, start, end, new Date(...)) without being turned
 * into a string or number first (.toISOString(), .getTime(), Number(...)).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOTS = ["app", "lib", "db", "components", "scripts"];
const DATE_LIKE = /(^|[^\w])(now|new Date\b|\w*At|\w*Date|cutoff|since|start|end)\b/;
const SAFE = /\.toISOString\(\)|\.getTime\(\)|^Number\(|^String\(|^schema\.|\bsql`/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

function rawSqlFragments() {
  const out: { file: string; line: number; values: string[] }[] = [];
  for (const f of ROOTS.flatMap(files)) {
    const src = readFileSync(f, "utf8");
    const re = /sql`((?:[^`\\]|\\.)*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const values = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim());
      out.push({ file: f.replace(/\\/g, "/"), line: src.slice(0, m.index).split("\n").length, values });
    }
  }
  return out;
}

describe("SEC-62 raw SQL never embeds a JS Date", () => {
  it("every interpolated value in a raw sql fragment is a column, a number/string, or an explicitly converted date", () => {
    const frags = rawSqlFragments();
    expect(frags.length).toBeGreaterThan(10); // the scan really found the fragments
    const bad = frags.flatMap((f) => f.values.filter((v) => !SAFE.test(v) && DATE_LIKE.test(v)).map((v) => `${f.file}:${f.line} → \${${v}}`));
    expect(bad, `Convert these with .toISOString() (and ::timestamptz) or use Drizzle operators:\n${bad.join("\n")}`).toEqual([]);
  });

  it("the guard itself catches the SEC-48 pattern", () => {
    expect(DATE_LIKE.test("now") && !SAFE.test("now")).toBe(true);
    expect(DATE_LIKE.test("b.holdExpiresAt") && !SAFE.test("b.holdExpiresAt")).toBe(true);
    expect(SAFE.test("now.toISOString()")).toBe(true);
    expect(SAFE.test("schema.bookings.startAt")).toBe(true);
  });
});
