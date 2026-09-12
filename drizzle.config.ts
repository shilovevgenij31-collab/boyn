import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as a standalone CLI, outside Next.js's own env loading —
// load .env.local/.env the same minimal way scripts/provider-spike does,
// so `npm run db:generate`/`db:migrate` work without a separate env step.
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

// Migrations run against the direct/unpooled connection; fall back to
// DATABASE_URL so `db:generate` (which doesn't touch the network) doesn't
// require both to be set.
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: connectionString },
  strict: true,
  verbose: true,
});
