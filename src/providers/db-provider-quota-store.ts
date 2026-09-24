/**
 * Durable QUOTA-tracker state via Phase 3's `app_settings` table — same
 * mechanism/durability guarantee as db-circuit-breaker-store.ts, kept in
 * its own file for the identical reason: quota-tracker.ts's pure logic
 * stays DB-free and trivially unit-testable.
 */
import type { Database } from "@/db/client.ts";
import { getSetting, setSetting } from "@/db/repositories/settings.ts";
import { quotaKeyToString, type ProviderQuotaStore, type QuotaKey } from "./quota-tracker.ts";

export class DbProviderQuotaStore implements ProviderQuotaStore {
  constructor(private readonly db: Database) {}

  async get(key: QuotaKey): Promise<Date | null> {
    const recordedAtIso = await getSetting<string>(this.db, quotaKeyToString(key));
    return recordedAtIso ? new Date(recordedAtIso) : null;
  }

  async save(key: QuotaKey, recordedAt: Date): Promise<void> {
    await setSetting(this.db, quotaKeyToString(key), recordedAt.toISOString(), recordedAt);
  }
}
