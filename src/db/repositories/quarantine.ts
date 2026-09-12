/**
 * Malformed-item quarantine (Phase 5 brief §24-25). One bad item must
 * never fail a whole job's ingestion, and never store secrets.
 *
 * Idempotency: `quarantined_items` has no unique constraint (Phase 3 chose
 * not to invent one on an unverified natural key). Replay safety instead
 * comes primarily from the job state machine — a READY job transitions to
 * INGESTED exactly once, so normal replay never re-quarantines anything.
 * The one gap that leaves open is a crash MID-ingestion (some items
 * already quarantined, job still READY, picked up again) — guarded here
 * with a cheap identical-payload check scoped to the same job, rather than
 * a schema migration for an unverified key shape.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { quarantinedItems } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderId } from "@/core/domain/provider.ts";

export interface QuarantineItemParams {
  provider: ProviderId;
  platform: Platform;
  providerJobId: number | null;
  payload: Record<string, unknown>;
  error: string;
  now: Date;
}

export async function quarantineItem(db: Database, params: QuarantineItemParams): Promise<{ inserted: boolean }> {
  if (params.providerJobId !== null) {
    const existing = await db
      .select({ id: quarantinedItems.id })
      .from(quarantinedItems)
      .where(
        and(
          eq(quarantinedItems.providerJobId, params.providerJobId),
          sql`${quarantinedItems.payload}::text = ${JSON.stringify(params.payload)}`,
        ),
      )
      .limit(1);
    if (existing[0]) return { inserted: false };
  }

  await db.insert(quarantinedItems).values({
    provider: params.provider,
    platform: params.platform,
    providerJobId: params.providerJobId,
    payload: params.payload,
    error: params.error,
    createdAt: params.now,
  });
  return { inserted: true };
}
