import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema.ts";

export type TestDatabase = PgliteDatabase<typeof schema>;

const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

/** A fresh, fully-migrated, in-memory Postgres-compatible database — no
 * Docker, no Neon credentials, no network. One instance per call, so
 * tests that want isolation just call this again. */
export async function createTestDb(): Promise<{ db: TestDatabase; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => client.close() };
}
