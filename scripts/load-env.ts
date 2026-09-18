/**
 * Minimal `.env.local`/`.env` loader for standalone scripts (Phase 9
 * deployment fix). `drizzle.config.ts` and `scripts/provider-spike/env.ts`
 * each already carry their own copy of this exact snippet since
 * drizzle-kit and the provider spike run outside Next.js's own env
 * loading; every OTHER script under `scripts/` that reads
 * `process.env.*` (db-seed, report, collection-pause, telegram:*) had no
 * such loader at all, silently requiring the operator to `export` every
 * variable by hand before running an otherwise plain `npm run db:seed`
 * (contradicting docs/RUNBOOK.md, which documents it as a plain command).
 *
 * Import this once, for its side effect, as the FIRST import in any
 * script that reads `process.env.*` before anything else does. Never
 * overrides an already-set `process.env` value (matches dotenv's usual
 * precedence, and Vercel's real runtime env always wins in production).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const filename of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), filename);
  if (!existsSync(path)) continue;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
