/**
 * Owner account tools for a live database (no seed needed). Uses DATABASE_URL from the environment
 * or .env. [SEC-53]
 *
 *   npm run admin:create -- --email owner@venue.in --name "Venue Owner" --phone +919812345678 [--force]
 *   npm run admin:remove-demo
 *   npm run admin:recover -- --email owner@venue.in [--phone +919812345678]
 *
 * admin:create asks for the password without showing it (or reads one line from stdin when piped).
 */
import { readFileSync } from "node:fs";
import readline from "node:readline";
import { closeDb } from "@/db/client";
import { createOwner, recoverAdmin, removeDemoAdmins, ToolError } from "@/lib/admin/tools";

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env */
  }
}

function args() {
  const out: Record<string, string | true> = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    out[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  }
  return out;
}

/** Reads a password without echoing it (TTY), or one line from stdin (piped). */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    rl.question(process.stdin.isTTY ? "" : "", (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  loadEnvFile();
  if (!process.env.DATABASE_URL) console.warn("DATABASE_URL is not set: using the local demo database (PGlite).");
  const cmd = process.argv[2];
  const a = args();
  switch (cmd) {
    case "create": {
      if (typeof a.email !== "string" || typeof a.name !== "string" || typeof a.phone !== "string") throw new ToolError("Usage: npm run admin:create -- --email … --name … --phone +91…");
      const pw = await askHidden("New owner password (10+ characters, not common, not your email): ");
      const again = process.stdin.isTTY ? await askHidden("Type it again: ") : pw;
      if (pw !== again) throw new ToolError("The passwords don't match.");
      const u = await createOwner({ email: a.email, name: a.name, phone: a.phone, password: pw, force: a.force === true });
      console.log(`Created owner ${u.email}. Sign in at /admin/login; a login code goes to the phone, and 10 recovery codes are shown once.`);
      break;
    }
    case "remove-demo": {
      const done = await removeDemoAdmins();
      console.log(done.length ? `Deactivated: ${done.join(", ")}` : "No active demo accounts.");
      break;
    }
    case "recover": {
      if (typeof a.email !== "string") throw new ToolError("Usage: npm run admin:recover -- --email … [--phone +91…]");
      const r = await recoverAdmin({ email: a.email, phone: typeof a.phone === "string" ? a.phone : undefined });
      console.log(`Temporary password for ${r.email} (shown once, must be changed at login):\n\n  ${r.temporaryPassword}\n`);
      console.log(`All sessions and trusted devices are signed out and recovery codes deleted. Login codes go to ${r.phone ?? "(no phone set — add one with --phone)"}.`);
      break;
    }
    default:
      throw new ToolError("Commands: create | remove-demo | recover");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof ToolError ? `Error: ${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
