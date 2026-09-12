import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { appSettings } from "@/db/schema.ts";

/** Generic key/value durable state (Phase 3's `app_settings` table) —
 * used by the circuit breaker (Phase 4) and reserved for future flags
 * like `collection_paused` or a budget override. */
export async function getSetting<T>(db: Database, key: string): Promise<T | null> {
  const rows = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return rows[0] ? (rows[0].value as T) : null;
}

export async function setSetting(db: Database, key: string, value: unknown, updatedAt: Date): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: sql.raw('excluded."value"'), updatedAt: sql.raw('excluded."updated_at"') },
    });
}
