import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { trackedHashtags } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";

export interface EnsureTrackedHashtagParams {
  hashtagId: number;
  platform: Platform;
  market: string;
  tier: "CORE" | "ACTIVE" | "EXPLORATION" | "DORMANT";
  source: "SEED" | "DISCOVERED" | "MANUAL";
  priority?: number;
}

export interface EnsureTrackedHashtagResult {
  id: number;
  created: boolean;
}

/**
 * Idempotent, non-destructive: creates the row if it doesn't exist yet,
 * and does NOTHING to an existing one (Phase 3 brief §13/§35 — a tracked
 * hashtag's tier/priority/scan counters are evolving state that Phase 6's
 * lifecycle logic will own; re-running this must never reset it back to
 * seed defaults). Callers that actually want to change an existing row's
 * tier should do so explicitly and separately — no such mutation exists
 * yet, deliberately (no lifecycle logic in Phase 3).
 */
export async function ensureTrackedHashtag(
  db: Database,
  params: EnsureTrackedHashtagParams,
): Promise<EnsureTrackedHashtagResult> {
  const inserted = await db
    .insert(trackedHashtags)
    .values({
      hashtagId: params.hashtagId,
      platform: params.platform,
      market: params.market,
      tier: params.tier,
      source: params.source,
      priority: params.priority !== undefined ? params.priority.toString() : undefined,
    })
    .onConflictDoNothing({ target: [trackedHashtags.hashtagId, trackedHashtags.platform, trackedHashtags.market] })
    .returning({ id: trackedHashtags.id });

  if (inserted[0]) {
    return { id: inserted[0].id, created: true };
  }

  const existing = await db
    .select({ id: trackedHashtags.id })
    .from(trackedHashtags)
    .where(
      and(
        eq(trackedHashtags.hashtagId, params.hashtagId),
        eq(trackedHashtags.platform, params.platform),
        eq(trackedHashtags.market, params.market),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error("ensureTrackedHashtag: row neither inserted nor found — this should be unreachable");
  return { id: row.id, created: false };
}
