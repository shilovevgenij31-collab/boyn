import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { hashtags, trackedHashtags } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { DueHashtagCandidate } from "@/core/scheduling/tag-selector.ts";
import { computeNextDueAt } from "@/core/scheduling/tag-selector.ts";

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

/**
 * Due candidates for one tier group (Phase 5 brief §8-10), oldest-due-first
 * (nulls — never scanned — first). `core/scheduling/tag-selector.ts`'s
 * `selectHashtagsForDiscovery` composes CORE/ACTIVE/EXPLORATION+DORMANT
 * groups fetched this way into one batch; this function does the actual
 * SQL, scoped to a single (platform, market, tiers) selection.
 */
export async function getDueTrackedHashtagsByTier(
  db: Database,
  platform: Platform,
  market: string,
  tiers: ("CORE" | "ACTIVE" | "EXPLORATION" | "DORMANT")[],
  now: Date,
  limit: number,
): Promise<DueHashtagCandidate[]> {
  const rows = await db
    .select({
      trackedHashtagId: trackedHashtags.id,
      hashtagId: trackedHashtags.hashtagId,
      hashtagName: hashtags.name,
      tier: trackedHashtags.tier,
      source: trackedHashtags.source,
      trendState: trackedHashtags.trendState,
      nextDueAt: trackedHashtags.nextDueAt,
    })
    .from(trackedHashtags)
    .innerJoin(hashtags, eq(hashtags.id, trackedHashtags.hashtagId))
    .where(
      and(
        eq(trackedHashtags.platform, platform),
        eq(trackedHashtags.market, market),
        inArray(trackedHashtags.tier, tiers),
        eq(hashtags.isBlocked, false),
        or(isNull(trackedHashtags.nextDueAt), sql`${trackedHashtags.nextDueAt} <= ${now}`),
      ),
    )
    .orderBy(sql`${trackedHashtags.nextDueAt} nulls first`)
    .limit(limit);

  return rows;
}

/**
 * After a discovery job successfully scans a tag (Phase 5 brief §35-36):
 * advance last_scanned_at/next_due_at per its current tier/source/
 * trend_state, bump scans_total, and update consecutive_empty_scans. Never
 * changes tier (Phase 6 lifecycle owns promotion/demotion).
 *
 * Also bumps probes_in_tier (Phase 6 brief §37-38's EXPLORATION_DEMOTION
 * evidence: "2 probes / 4 days") — it's reset to 0 by
 * analytics-hashtags.ts's applyTierTransition whenever a tier actually
 * changes, so its value always means "scans since entering the CURRENT
 * tier", for whichever tier the tag happens to be in.
 */
export async function recordHashtagScanned(
  db: Database,
  trackedHashtagId: number,
  params: {
    tier: "CORE" | "ACTIVE" | "EXPLORATION" | "DORMANT";
    source: "SEED" | "DISCOVERED" | "MANUAL";
    trendState: "BREAKOUT" | "RISING" | "ACTIVE" | "STABLE" | "FALLING" | "DEAD" | "NEW";
    now: Date;
    recordsReturned: number;
  },
): Promise<void> {
  const nextDueAt = computeNextDueAt(params.tier, params.source, params.trendState, params.now);
  await db
    .update(trackedHashtags)
    .set({
      lastScannedAt: params.now,
      nextDueAt,
      scansTotal: sql`${trackedHashtags.scansTotal} + 1`,
      probesInTier: sql`${trackedHashtags.probesInTier} + 1`,
      consecutiveEmptyScans:
        params.recordsReturned > 0 ? 0 : sql`${trackedHashtags.consecutiveEmptyScans} + 1`,
    })
    .where(eq(trackedHashtags.id, trackedHashtagId));
}

/**
 * A discovery job that failed completely (not merely "zero results") must
 * NOT retry immediately — a short bounded backoff avoids a retry storm
 * (Phase 5 brief §35) without pushing the tag as far out as a successful
 * scan would (so genuinely-transient provider trouble self-heals soon).
 */
export async function recordHashtagScanFailed(db: Database, trackedHashtagId: number, now: Date, retryAfterHours: number): Promise<void> {
  await db
    .update(trackedHashtags)
    .set({ nextDueAt: new Date(now.getTime() + retryAfterHours * 3_600_000) })
    .where(eq(trackedHashtags.id, trackedHashtagId));
}
