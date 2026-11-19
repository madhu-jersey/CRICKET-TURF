// Checks that every repository file path mentioned in a Markdown doc exists.
// Usage: node scripts/check-doc-paths.mjs [docs/ARCHITECTURE.md]
// A "path" is an inline-code span (`...`) that looks like a repo path: it contains a "/" or ends in a
// known file extension, and doesn't start with "/" (URL routes) or contain spaces, "*", "<" or "://".
// Paths given as `file › function()` or `file:line` are checked by the file part. Fenced code blocks are skipped.
import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "docs/ARCHITECTURE.md";
const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
const EXT = /\.(ts|tsx|mjs|js|json|sql|md|yml|yaml|tsv|css)$/;
const ROOTS = /^(app|components|config|db|lib|scripts|tests|docs|\.github|\.zap)\//;

const found = new Map();
for (const m of text.matchAll(/`([^`\n]+)`/g)) {
  // `file › function()` and `file:123` / `file:12-34` both point at a file.
  let p = m[1].split("›")[0].trim().replace(/:\d+(-\d+)?$/, "");
  if (!p || p.startsWith("/") || /[\s*<>]|:\/\//.test(p)) continue;
  if (!(EXT.test(p) || ROOTS.test(p))) continue;
  if (!p.includes("/") && !existsSync(p)) {
    // bare file names (e.g. `pricing.test.ts`) must exist somewhere we name explicitly
    continue;
  }
  const line = text.slice(0, m.index).split("\n").length;
  if (!found.has(p)) found.set(p, line);
}

const missing = [...found].filter(([p]) => !existsSync(p.replace(/\/$/, "")));
console.log(`${found.size} paths checked in ${file}`);
for (const [p, line] of missing) console.log(`MISSING  ${p}  (first mention near line ${line}, outside code blocks)`);
if (missing.length) process.exit(1);
console.log("All paths exist.");
